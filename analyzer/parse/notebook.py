"""Jupyter notebook parsing.

Notebook bytes are a lie.  A notebook that is 4.9 MB on disk can hold 115 lines
of actual code, because the rest is base64 PNG output.  Height therefore comes
from *cell source* only, and outputs are never even looked at.

Note: neither reference repository contains a notebook, so this parser is proven
by fixtures rather than by the demo cities.
"""

from __future__ import annotations

import json

from . import Floor, ParseResult, _shorten


def _logical_lines(source: str) -> int:
    count = 0
    for line in source.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        count += 1
    return count


def parse_notebook(source: str) -> ParseResult:
    doc = json.loads(source)
    if not isinstance(doc, dict):
        return ParseResult(language="notebook", confidence="low")

    cells = doc.get("cells")
    if not isinstance(cells, list):
        # nbformat 3 used `worksheets`; accept it rather than failing.
        cells = []
        for sheet in doc.get("worksheets") or []:
            if isinstance(sheet, dict):
                cells.extend(sheet.get("cells") or [])

    floors: list[Floor] = []
    code_loc = 0
    code_comments = 0
    markdown_lines = 0
    kernel = ""
    meta = doc.get("metadata")
    if isinstance(meta, dict):
        kernelspec = meta.get("kernelspec")
        if isinstance(kernelspec, dict):
            kernel = kernelspec.get("language") or kernelspec.get("name") or ""

    for cell in cells:
        if not isinstance(cell, dict):
            continue
        kind = cell.get("cell_type")
        raw = cell.get("source") or cell.get("input") or ""
        if isinstance(raw, list):
            raw = "".join(str(p) for p in raw)
        raw = str(raw)

        if kind == "code":
            loc = _logical_lines(raw)
            code_loc += loc
            code_comments += sum(
                1 for line in raw.splitlines() if line.strip().startswith("#")
            )
            first = next(
                (line.strip() for line in raw.splitlines() if _worth_showing(line)),
                "",
            )
            floors.append(
                Floor(
                    name=_shorten(first, 80) or "cell",
                    kind="cell",
                    line=0,
                    end_line=0,
                    loc=loc,
                    depth=0,
                )
            )
        elif kind == "markdown":
            markdown_lines += sum(1 for line in raw.splitlines() if line.strip())
            first = next((line.strip().lstrip("#").strip() for line in raw.splitlines() if line.strip()), "")
            floors.append(
                Floor(
                    name=_shorten(first, 80) or "note",
                    kind="heading",
                    line=0,
                    end_line=0,
                    loc=0,
                    depth=0,
                )
            )

    return ParseResult(
        language="notebook",
        logical_loc=code_loc,
        floors=floors,
        comment_lines=code_comments,
        doc_lines=code_comments + markdown_lines,
        confidence="high",
    )


def _worth_showing(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not stripped.startswith("#")
