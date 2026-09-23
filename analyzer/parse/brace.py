"""Brace-family scanner for js/ts/jsx/tsx/java/go/c/cpp/cs/rs/kt/swift/php/scala.

This is a **heuristic**.  It strips strings and comments with a small state
machine, tracks brace depth, and regex-matches declarations that sit at depth 0.
That is enough to count floors and comment ratio honestly; it is not an AST and
must not be trusted for anything semantic.  Results carry
``confidence="medium"`` to say so out loud.
"""

from __future__ import annotations

import re

from . import Floor, ParseResult, _shorten

STRING_QUOTES = {'"', "'", "`"}

_CLASS_KEYWORDS = ("class", "interface", "struct", "enum", "impl", "trait", "object",
                   "protocol", "extension", "record", "union", "namespace")
_FUNC_KEYWORDS = ("function", "func", "fn", "def", "fun", "sub", "proc", "constructor")

# Regexes built per language family, applied to the masked source.
_RE_CLASS = re.compile(
    r"^\s*(?:(?:export|public|private|protected|internal|abstract|final|open|sealed|data|"
    r"pub|static|partial|async)\s+)*"
    r"(?:" + "|".join(_CLASS_KEYWORDS) + r")\s+([A-Za-z_$][\w$]*)"
)
_RE_FUNC = re.compile(
    r"^\s*(?:(?:export|public|private|protected|internal|abstract|final|open|sealed|"
    r"pub|static|partial|async|virtual|override|synchronized|native|unsafe|inline|"
    r"constexpr|extern|default)\s+)*"
    r"(?:" + "|".join(_FUNC_KEYWORDS) + r")\s+\*?\s*([A-Za-z_$][\w$]*)"
)
# `const handler = async (a) => {}` / `let f = function () {}`
_RE_ASSIGN_FN = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
    r"(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)"
)
# Java/C#/C++ style: `public static int compute(` at depth 0.
_RE_METHOD_FORM = re.compile(
    r"^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|"
    r"abstract|synchronized|native|unsafe|async|inline|constexpr|explicit|friend|"
    r"sealed|partial|extern|\s)+)"
    r"[A-Za-z_][\w:<>,\[\]\.\?\*\s&]*?\s+([A-Za-z_]\w*)\s*\("
)

METHOD_FORM_LANGS = {"java", "csharp", "cpp", "c", "dart", "groovy", "scala", "kt", "kotlin"}

# Keywords that a method-form match must not be mistaken for.
_CONTROL = {
    "if", "for", "while", "switch", "catch", "return", "do", "else", "case", "new",
    "throw", "try", "using", "foreach", "synchronized", "sizeof", "typeof", "delete",
    "await", "yield", "assert", "sizeof", "namespace",
}


def _strip(source: str, language: str) -> tuple[list[str], list[int], set[int]]:
    """Return (masked lines, depth at start of each line, pure-comment lines).

    Strings and comments are replaced by spaces while newlines are preserved, so
    offsets stay aligned with the original source and regex matching cannot see
    a declaration inside a string literal.
    """
    hash_comments = language in {"php", "perl", "shell", "ruby", "python", "r"}
    out: list[str] = []
    depth_at_line: list[int] = []
    comment_only: set[int] = set()

    depth = 0
    line = 1
    i = 0
    n = len(source)
    line_has_code = False
    line_has_comment = False
    depth_at_line.append(0)

    def newline() -> None:
        nonlocal line, line_has_code, line_has_comment
        out.append("\n")
        if line_has_comment and not line_has_code:
            comment_only.add(line)
        line += 1
        line_has_code = False
        line_has_comment = False
        depth_at_line.append(depth)

    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""

        if ch == "\n":
            newline()
            i += 1
            continue

        if ch == "/" and nxt == "/":
            while i < n and source[i] != "\n":
                i += 1
            line_has_comment = True
            continue
        if hash_comments and ch == "#":
            while i < n and source[i] != "\n":
                i += 1
            line_has_comment = True
            continue
        if ch == "/" and nxt == "*":
            i += 2
            line_has_comment = True
            while i < n and not (source[i] == "*" and i + 1 < n and source[i + 1] == "/"):
                if source[i] == "\n":
                    newline()
                i += 1
            i += 2
            continue
        if ch in STRING_QUOTES:
            quote = ch
            i += 1
            while i < n:
                cur = source[i]
                if cur == "\\":
                    i += 2
                    continue
                if cur == quote:
                    i += 1
                    break
                if cur == "\n":
                    # Unterminated string (or a regex literal): stop at line end.
                    newline()
                    i += 1
                    if quote != "`":
                        break
                    continue
                i += 1
            line_has_code = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        if not ch.isspace():
            line_has_code = True
        out.append(ch)
        i += 1

    return "".join(out).splitlines(), depth_at_line, comment_only


# Relative import/require specifiers only: `import x from 'react'` cannot
# resolve to a file in this repo and is not worth carrying past this module.
# Applied to the raw source rather than the masked one -- a heuristic on top
# of a heuristic, medium confidence either way, and false positives from a
# commented-out import are rare enough not to matter for a centrality score.
_RE_RELATIVE_IMPORT = re.compile(
    r"""(?:from|import)\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)"""
)


def _relative_imports(source: str) -> list[str]:
    imports = []
    for match in _RE_RELATIVE_IMPORT.finditer(source):
        imports.append(match.group(1) or match.group(2))
    return imports


def parse_brace(source: str, language: str) -> ParseResult:
    masked_lines, depth_at_line, comment_only = _strip(source, language)

    lines = source.splitlines()
    blank = sum(1 for line in lines if not line.strip())
    comment_lines = len(comment_only)
    logical = max(0, len(lines) - blank - comment_lines)

    floors: list[Floor] = []
    seen: set[tuple[str, int]] = set()
    candidates: list[tuple[int, Floor]] = []

    def depth_of(line_no: int) -> int:
        idx = min(line_no - 1, len(depth_at_line) - 1)
        return depth_at_line[idx] if idx >= 0 else 0

    def offer(line_no: int, name: str, kind: str) -> None:
        if (name, line_no) in seen:
            return
        seen.add((name, line_no))
        candidates.append(
            (depth_of(line_no), Floor(name=name, kind=kind, line=line_no, end_line=line_no, loc=1))
        )

    for idx, raw in enumerate(masked_lines, 1):
        if not raw.strip():
            continue

        match = _RE_FUNC.match(raw)
        if match and match.group(1) not in _CONTROL:
            offer(idx, match.group(1), "function")
            continue

        match = _RE_CLASS.match(raw)
        if match:
            offer(idx, match.group(1), "class")
            continue

        match = _RE_ASSIGN_FN.match(raw)
        if match:
            offer(idx, match.group(1), "function")
            continue

        if language in METHOD_FORM_LANGS:
            match = _RE_METHOD_FORM.match(raw)
            if match and match.group(1) not in _CONTROL and "=" not in raw.split("(", 1)[0]:
                offer(idx, match.group(1), "function")

    # Declarations are taken at the shallowest depth that has any, not strictly
    # at depth 0.  Wrapping everything in an IIFE -- `(function (global) { ... })`
    # -- is extremely common in browser JS, and a strict depth-0 rule reports
    # zero floors for a 1,384-line module.
    if candidates:
        base = min(depth for depth, _ in candidates)

        def block_end(start_line: int) -> int:
            """First line after `start_line` where the body has closed again.

            Gives each function a real extent rather than a single line, so an
            interior can show the function body and not just its signature.
            """
            for line_no in range(start_line + 1, len(depth_at_line) + 1):
                if depth_of(line_no) <= base:
                    return line_no
            return len(lines) + 1

        for depth, floor in candidates:
            if depth != base:
                continue
            floor.end_line = block_end(floor.line)
            floor.loc = max(1, floor.end_line - floor.line)
            floors.append(floor)

    return ParseResult(
        language=language,
        logical_loc=logical,
        floors=floors,
        comment_lines=comment_lines,
        doc_lines=comment_lines,
        confidence="medium",
        imports=_relative_imports(source) if language in ("javascript", "typescript") else [],
    )
