"""Python parsing via the standard-library ``ast`` module.

Height comes from logical source lines, not bytes.  Logical means: physical
lines minus blank lines, minus comment lines (found with ``tokenize``, so a ``#``
inside a string is not miscounted), minus docstring bodies (found with ``ast``,
so a long help block does not inflate the building).

Floors are one per top-level function or class, with methods hanging off a class
as nested floors at ``depth=1``.
"""

from __future__ import annotations

import ast
import io
import tokenize

from . import Floor, ParseResult, _shorten


def _comment_lines(source: str) -> set[int]:
    """Exact line numbers occupied by ``#`` comments."""
    found: set[int] = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                found.add(tok.start[0])
    except (tokenize.TokenError, IndentationError, SyntaxError):
        # Broken file: fall back to a line-level heuristic.
        for i, line in enumerate(source.splitlines(), 1):
            if line.strip().startswith("#"):
                found.add(i)
    return found


def _docstring_lines(tree: ast.AST) -> set[int]:
    """Line numbers covered by module, class and function docstrings."""
    covered: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            start = first.lineno
            end = getattr(first, "end_lineno", start) or start
            covered.update(range(start, end + 1))
    return covered


def _floor_from(node: ast.AST, kind: str, depth: int, docstring: str) -> Floor:
    start = getattr(node, "lineno", 0) or 0
    end = getattr(node, "end_lineno", start) or start
    return Floor(
        name=getattr(node, "name", "<anonymous>"),
        kind=kind,
        doc=_shorten(docstring),
        line=start,
        # ast end_lineno is inclusive; floors use half-open [line, end_line).
        end_line=end + 1,
        loc=max(1, end - start + 1),
        depth=depth,
    )


def parse_python(source: str) -> ParseResult:
    tree = ast.parse(source)
    comments = _comment_lines(source)
    docstrings = _docstring_lines(tree)
    total = len(source.splitlines())

    blank = sum(1 for line in source.splitlines() if not line.strip())
    logical = total - blank - len(comments - docstrings) - len(docstrings)
    logical = max(0, logical)

    floors: list[Floor] = []
    symbols = 0
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            floors.append(_floor_from(node, "function", 0, ast.get_docstring(node) or ""))
            symbols += 1
        elif isinstance(node, ast.ClassDef):
            floors.append(_floor_from(node, "class", 0, ast.get_docstring(node) or ""))
            symbols += 1
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    floors.append(
                        _floor_from(child, "method", 1, ast.get_docstring(child) or "")
                    )
                    symbols += 1

    return ParseResult(
        language="python",
        logical_loc=logical,
        floors=floors,
        comment_lines=len(comments),
        doc_lines=len(comments | docstrings),
        confidence="high",
    )
