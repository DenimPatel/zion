"""Per-file source parsing.

Every parser answers the same questions so the city can be built without the
viewer ever seeing source code:

  * how tall is this building?      -> ``logical_loc`` (never raw bytes)
  * how many floors does it have?   -> ``floors``
  * how well documented is it?      -> ``doc_lines`` / ``logical_loc``
  * how many rows of data?          -> ``rows`` for silos

Parsers only ever see one file at a time and never raise: a file that cannot be
parsed degrades to the generic line-based fallback with ``confidence="low"``,
because a city with a missing building is worse than a city with a plain one.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# Shared result types
# --------------------------------------------------------------------------


@dataclass
class Floor:
    """One floor of a building: a function, class, heading, cell or section."""

    name: str
    kind: str = "symbol"      # function | class | method | heading | cell | section
    doc: str = ""             # first docstring / first prose line, truncated
    line: int = 0             # 1-based start line in the source
    end_line: int = 0
    loc: int = 0              # lines of source this floor spans
    depth: int = 0            # 0 = top level, 1 = nested (methods inside a class)
    is_entrypoint: bool = False  # a __main__ guard or a function literally named main
    complexity: int = 0       # decision points: If/For/While/Try/BoolOp/comprehension (exact
                              # for Python; a keyword count for brace languages, medium confidence)


@dataclass
class ParseResult:
    language: str = "unknown"
    logical_loc: int = 0
    physical_lines: int = 0   # raw lines on disk, reported but never used for height
    floors: list[Floor] = field(default_factory=list)
    comment_lines: int = 0
    doc_lines: int = 0        # comments + docstrings + prose: "documentation"
    rows: int | None = None   # data files only
    confidence: str = "high"  # high | medium | low
    parse_error: str = ""
    # Raw import specifiers, resolved to repo paths later in metrics.py (which
    # has the whole file list to resolve against, not just this one file).
    # Python: dotted module names, relative ones kept as literal leading dots
    # ("." + module, per import level). Brace languages: relative path
    # specifiers only ("./foo", "../bar/baz") -- a bare package name like
    # 'react' cannot resolve to a repo file and is not worth carrying.
    imports: list[str] = field(default_factory=list)
    # Abstractness (architecture.py's A in Martin's A/I/D): type definitions
    # found, and how many of them are abstract -- an ABC/Protocol or a class
    # with an @abstractmethod in Python (exact), `interface`/`trait`/
    # `protocol`/`abstract class` in brace languages (a keyword count, medium).
    classes: int = 0
    abstract_classes: int = 0
    # Debt markers in comments: (line, marker, text) for TODO/FIXME/HACK/XXX.
    debt: list[tuple[int, str, str]] = field(default_factory=list)
    # Winnowed fingerprints of the normalised source, for clone detection
    # (analyzer/clones.py); empty for anything that is not code.
    fingerprints: list[int] = field(default_factory=list)


DOC_TRUNCATE = 160


def _shorten(text: str, limit: int = DOC_TRUNCATE) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "\u2026"


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

PYTHON_EXTS = {".py", ".pyi"}
NOTEBOOK_EXTS = {".ipynb"}
MARKDOWN_EXTS = {".md", ".markdown", ".rst", ".mdx"}
HTML_EXTS = {".html", ".htm"}
BRACE_EXTS = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".java", ".go", ".c", ".h",
    ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".cs", ".rs", ".kt", ".kts", ".swift",
    ".php", ".scala", ".sc", ".dart", ".m", ".mm", ".groovy", ".sol", ".zig",
}
DATA_EXTS = {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".jsonc", ".parquet"}

# Lowercase basenames that carry a known language.
BASENAME_LANGS = {
    "dockerfile": "docker",
    "makefile": "make",
    "gemfile": "ruby",
    "rakefile": "ruby",
    "procfile": "conf",
}

COMMENT_PREFIXES = {
    "sh": "#", "bash": "#", "zsh": "#", "fish": "#", "yaml": "#", "yml": "#",
    "toml": "#", "ini": "#", "conf": "#", "python": "#", "ruby": "#", "r": "#",
    "make": "#", "docker": "#", "perl": "#", "text": "#", "sql": "--",
    "lua": "--", "vim": '"',
}

EXT_LANGS = {
    ".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript",
    ".tsx": "typescript", ".java": "java", ".go": "go", ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".cs": "csharp", ".rs": "rust", ".kt": "kotlin", ".kts": "kotlin",
    ".swift": "swift", ".php": "php", ".scala": "scala", ".sc": "scala",
    ".dart": "dart", ".m": "objectivec", ".mm": "objectivec",
    ".groovy": "groovy", ".sol": "solidity", ".zig": "zig",
    ".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown",
    ".rst": "markdown", ".mdx": "markdown", ".ipynb": "notebook",
    ".css": "css", ".scss": "css", ".sass": "css", ".less": "css",
    ".csv": "csv", ".tsv": "tsv", ".json": "json", ".jsonl": "jsonl",
    ".ndjson": "jsonl", ".jsonc": "json", ".yml": "yaml", ".yaml": "yaml",
    ".toml": "toml", ".ini": "ini", ".cfg": "ini", ".sh": "shell",
    ".bash": "shell", ".zsh": "shell", ".fish": "shell",
    ".rb": "ruby", ".sql": "sql", ".r": "r", ".jl": "julia", ".lua": "lua",
    ".pl": "perl", ".xml": "xml", ".svg": "xml", ".txt": "text",
    ".vue": "vue", ".svelte": "svelte", ".parquet": "data",
}


def language_for(name: str, ext: str) -> str:
    low = name.lower()
    if low in BASENAME_LANGS:
        return BASENAME_LANGS[low]
    if ext in EXT_LANGS:
        return EXT_LANGS[ext]
    if low == ".gitignore" or low == ".gitattributes" or low == ".dockerignore":
        return "text"
    return "unknown"


def generic_parse(source: str, language: str) -> ParseResult:
    """Fallback: logical lines plus a comment-prefix heuristic.

    This is the floor of the system.  A language we do not understand still
    produces a real building -- just one with a single untyped floor and
    ``confidence="low"`` so the legend can say so.
    """
    lines = source.splitlines()
    prefix = COMMENT_PREFIXES.get(language, "#")
    logical = 0
    comments = 0
    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        logical += 1
        if stripped.startswith(prefix):
            comments += 1
    return ParseResult(
        language=language,
        logical_loc=logical,
        floors=[],
        comment_lines=comments,
        doc_lines=comments,
        confidence="low",
    )


# Languages whose comments are scanned for debt markers and whose source is
# fingerprinted for clones: code, not prose, config or data.
CODE_LANGUAGES = {
    "python", "javascript", "typescript", "java", "go", "c", "cpp", "csharp", "rust", "kotlin",
    "swift", "php", "scala", "dart", "objectivec", "groovy", "solidity", "zig", "ruby", "shell",
    "lua", "perl", "r", "julia", "sql", "vue", "svelte",
}
DEBT_LIMIT = 50
# A marker counts only inside a comment, and only as a marker: the first word
# after the comment opener (`# TODO fix`, `// FIXME(ana): ...`, `/* HACK */`),
# or anywhere in the comment when a colon or owner follows (`# see TODO: x`).
# A comment that merely mentions the word is not debt, and `todo_list = []`
# is not a comment.
_DEBT_RE = re.compile(
    r"(?:#|//|/\*+|^\s*\*|--|<!--)\s*@?(TODO|FIXME|HACK|XXX)\b(?:\([^)]*\))?[:\s]*([^\n]*)"
    r"|(?:#|//|/\*|^\s*\*|--|<!--)[^\n]*?\b(TODO|FIXME|HACK|XXX)(?:\([^)]*\))?:\s*([^\n]*)"
)


def scan_debt(source: str) -> list[tuple[int, str, str]]:
    """TODO/FIXME/HACK/XXX markers in comments, with the text after them."""
    found: list[tuple[int, str, str]] = []
    if "TODO" not in source and "FIXME" not in source and "HACK" not in source and "XXX" not in source:
        return found
    for number, line in enumerate(source.splitlines(), 1):
        match = _DEBT_RE.search(line)
        if not match:
            continue
        marker = match.group(1) or match.group(3)
        text = (match.group(2) if match.group(1) else match.group(4)) or ""
        text = text.strip().rstrip("*/-> ").strip()
        found.append((number, marker, _shorten(text, 100)))
        if len(found) >= DEBT_LIMIT:
            break
    return found


def parse_text(name: str, source: str) -> ParseResult:
    """Parse a decoded text file.  Never raises."""
    result = _parse_text_inner(name, source)
    if not result.physical_lines:
        result.physical_lines = _count_physical(source)
    if result.language in CODE_LANGUAGES:
        try:
            result.debt = scan_debt(source)
            from ..clones import fingerprint

            result.fingerprints = fingerprint(source)
        except Exception:  # pragma: no cover - extras never break a parse
            pass
    return result


def _parse_text_inner(name: str, source: str) -> ParseResult:
    ext = os.path.splitext(name)[1].lower()
    language = language_for(name, ext)
    try:
        if ext in PYTHON_EXTS:
            from .python_ast import parse_python

            return parse_python(source)
        if ext in NOTEBOOK_EXTS:
            from .notebook import parse_notebook

            return parse_notebook(source)
        if ext in MARKDOWN_EXTS:
            from .markup import parse_markdown

            return parse_markdown(source)
        if ext in HTML_EXTS:
            from .markup import parse_html

            return parse_html(source)
        if ext in BRACE_EXTS:
            from .brace import parse_brace

            return parse_brace(source, language)
        if ext in DATA_EXTS:
            from .tabular import parse_data

            return parse_data(source, language)
    except Exception as exc:  # pragma: no cover - defensive by design
        degraded = generic_parse(source, language)
        degraded.confidence = "low"
        degraded.parse_error = f"{type(exc).__name__}: {exc}"[:200]
        return degraded
    return generic_parse(source, language)


def read_text(path: str, limit: int | None = None) -> str:
    """Read a file as text, replacing undecodable bytes.

    ``limit`` bounds how many bytes are decoded, used for very large files
    where counting lines is enough and the tail is not worth the memory.
    """
    with open(path, "rb") as fh:
        raw = fh.read() if limit is None else fh.read(limit)
    return raw.decode("utf-8", errors="replace")


def parse_file(path: str, name: str, is_binary: bool) -> ParseResult:
    """Parse one file from disk."""
    if is_binary:
        return ParseResult(language="binary", logical_loc=0, confidence="high")
    ext = os.path.splitext(name)[1].lower()
    language = language_for(name, ext)
    # Data files are streamed from disk rather than decoded into memory; a
    # multi-gigabyte data asset must cost constant memory.
    if ext in DATA_EXTS and ext != ".parquet":
        try:
            from .tabular import parse_data_file

            data_result = parse_data_file(path, language, ext)
            data_result.physical_lines = count_physical_lines(path)
            return data_result
        except Exception as exc:  # pragma: no cover - defensive by design
            res = ParseResult(language=language, confidence="low")
            res.parse_error = f"{type(exc).__name__}: {exc}"[:200]
            return res
    try:
        source = read_text(path)
    except OSError as exc:
        res = ParseResult(language="unknown", confidence="low")
        res.parse_error = f"OSError: {exc}"
        return res
    result = parse_text(name, source)
    result.physical_lines = _count_physical(source)
    return result


def _count_physical(source: str) -> int:
    if not source:
        return 0
    return source.count("\n") + (0 if source.endswith("\n") else 1)


def count_physical_lines(path: str) -> int:
    """Count newlines without decoding, for data files read in chunks."""
    count = 0
    last_byte = b""
    try:
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1 << 16)
                if not chunk:
                    break
                count += chunk.count(b"\n")
                last_byte = chunk[-1:]
    except OSError:
        return 0
    if last_byte and last_byte != b"\n":
        count += 1
    return count
