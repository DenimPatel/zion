"""Data file parsing: row counts, streamed, never fully loaded.

A 116,769-byte JSON file with **zero newlines** is the reason this module does
not count lines.  Silo height has to come from logical rows, so:

  * CSV/TSV  -> data rows counted with ``csv.reader`` over an on-disk stream.
  * JSON     -> the length of the largest top-level array (the table inside the
                document), falling back to the number of top-level keys.
                ``llm-bpe-vocab.json`` measures 1,565 rows, not 2 keys and not
                1 line.
  * JSONL    -> record count.

Files are read in chunks with a small state machine, so a multi-gigabyte data
asset costs constant memory.
"""

from __future__ import annotations

import csv
import io

from . import ParseResult

CHUNK = 1 << 16


def _count_delimited(path: str, delimiter: str) -> int:
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.reader(fh, delimiter=delimiter)
        total = 0
        try:
            for _ in reader:
                total += 1
        except csv.Error:
            pass
    return max(0, total - 1)  # drop the header


def _count_jsonl(path: str) -> int:
    count = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip():
                count += 1
    return count


def count_json_rows(path: str) -> tuple[int, int, int]:
    """Stream a JSON document and return (largest_top_level_array, keys, depth).

    ``largest_top_level_array`` is the row proxy; ``keys`` is the fallback for a
    document that is a plain object of scalars.
    """
    depth = 0
    in_string = False
    escape = False
    root_is_object: bool | None = None
    keys = 0
    expecting_key = False

    # Array element counting for arrays that sit directly under a top-level key.
    tracking_array = False
    arr_commas = 0
    arr_has_element = False
    largest = 0

    # Top-level array (document is itself a list).
    top_commas = 0
    top_has_element = False

    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            for ch in chunk.decode("utf-8", errors="replace"):
                if in_string:
                    if escape:
                        escape = False
                    elif ch == "\\":
                        escape = True
                    elif ch == '"':
                        in_string = False
                    continue

                if ch == '"':
                    in_string = True
                    if root_is_object and depth == 1 and expecting_key:
                        keys += 1
                        expecting_key = False
                    continue

                if ch == "{" or ch == "[":
                    # A container that *opens* inside a tracked array is itself
                    # an element of that array, so an array of objects must
                    # count as non-empty.  (Counting only scalar characters got
                    # this wrong: every separator was a comma at the parent
                    # depth and nothing ever marked the array as populated.)
                    if root_is_object is False and depth == 1:
                        top_has_element = True
                    elif root_is_object and depth == 2 and tracking_array:
                        arr_has_element = True

                    depth += 1
                    if depth == 1:
                        root_is_object = ch == "{"
                        expecting_key = ch == "{"
                    elif depth == 2 and root_is_object and ch == "[":
                        tracking_array = True
                        arr_commas = 0
                        arr_has_element = False
                    continue

                if ch == "}" or ch == "]":
                    if depth == 2 and tracking_array and ch == "]":
                        length = arr_commas + 1 if arr_has_element else 0
                        largest = max(largest, length)
                        tracking_array = False
                    depth = max(0, depth - 1)
                    continue

                if depth == 1 and root_is_object is False:
                    if ch == ",":
                        top_commas += 1
                    elif not ch.isspace():
                        top_has_element = True
                    continue

                if depth == 2 and tracking_array:
                    if ch == ",":
                        arr_commas += 1
                    elif not ch.isspace():
                        arr_has_element = True
                    continue

                if depth == 1 and root_is_object and ch == ",":
                    expecting_key = True

    if root_is_object is False:
        length = top_commas + 1 if top_has_element else 0
        largest = max(largest, length)

    return largest, keys, depth


def parse_data_file(path: str, language: str, ext: str) -> ParseResult:
    """Parse a data file from disk with constant memory."""
    rows = 0
    try:
        if ext == ".csv":
            rows = _count_delimited(path, ",")
        elif ext == ".tsv":
            rows = _count_delimited(path, "\t")
        elif ext in {".jsonl", ".ndjson"}:
            rows = _count_jsonl(path)
        elif ext in {".json", ".jsonc"}:
            largest, keys, _depth = count_json_rows(path)
            rows = max(largest, keys)
        elif ext == ".parquet":
            rows = 0
    except (OSError, ValueError):
        return ParseResult(language=language, confidence="low", rows=0)

    return ParseResult(
        language=language,
        logical_loc=rows,          # for silos, height is rows
        floors=[],                 # data files have no floors
        comment_lines=0,
        doc_lines=0,
        rows=rows,
        confidence="high" if rows else "medium",
    )


def parse_data(source: str, language: str) -> ParseResult:
    """In-memory variant, used by tests and small documents."""
    rows = 0
    if language == "csv":
        reader = csv.reader(io.StringIO(source), delimiter=",")
        rows = max(0, sum(1 for _ in reader) - 1)
    elif language == "tsv":
        reader = csv.reader(io.StringIO(source), delimiter="\t")
        rows = max(0, sum(1 for _ in reader) - 1)
    elif language == "jsonl":
        rows = sum(1 for line in source.splitlines() if line.strip())
    elif language == "json":
        import json

        try:
            doc = json.loads(source)
        except ValueError:
            return ParseResult(language=language, confidence="low", rows=0)
        if isinstance(doc, list):
            rows = len(doc)
        elif isinstance(doc, dict):
            arrays = [len(v) for v in doc.values() if isinstance(v, list)]
            rows = max(arrays) if arrays else len(doc)
    return ParseResult(
        language=language,
        logical_loc=rows,
        floors=[],
        rows=rows,
        confidence="high" if rows else "medium",
    )
