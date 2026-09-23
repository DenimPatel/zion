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


def _imports_from(tree: ast.AST) -> list[str]:
    """Raw import specifiers, resolved to repo paths later (metrics.py).

    ``import a.b.c`` yields ``"a.b.c"``. ``from a.b import c`` yields
    ``"a.b"`` -- the module, not the names pulled from it, since a symbol
    inside a module does not change which *file* the import points at.
    A relative ``from . import x`` / ``from ..pkg import y`` yields the
    literal leading dots plus whatever module followed them (``"."``,
    ``"..pkg"``), which metrics.py resolves against the importing file's own
    package directory.
    """
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            dots = "." * node.level
            module = node.module or ""
            if not dots and not module:
                continue
            # `from pkg import utils` is ambiguous between "the submodule
            # pkg.utils" and "the name utils inside pkg/__init__.py" without
            # deeper resolution than this parser does. Trying base.name first
            # (metrics.py's resolver falls back to shorter prefixes) covers
            # the more common submodule case while still finding the package
            # itself if that name is not actually a file. A dot separator is
            # only inserted between two non-empty parts, so `from . import x`
            # (dots=".", module="") yields ".x", not "..x".
            names = [alias.name for alias in node.names if alias.name != "*"]
            if names:
                imports.extend(f"{dots}{module}.{name}" if module else f"{dots}{name}" for name in names)
            else:
                imports.append(f"{dots}{module}")
    return imports


_COMPLEXITY_NODES = (
    ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try,
    ast.BoolOp, ast.comprehension, ast.With, ast.AsyncWith,
)


def _complexity_of(node: ast.AST) -> int:
    """Decision points inside one floor's own node -- not the whole file.

    A plain count of branch/loop/exception-handler/boolean-combination nodes.
    Not McCabe-exact (no +1 baseline, no match-case yet), but monotonic in the
    right direction: more branches, higher number.
    """
    return sum(1 for child in ast.walk(node) if isinstance(child, _COMPLEXITY_NODES))


def _entrypoint_names(tree: ast.AST) -> set[str]:
    """Names of functions the front door actually calls.

    A function literally named `main` is one entrypoint; the other is
    whatever a top-level `if __name__ == "__main__":` guard calls, which is
    often something else (`run`, `cli`, `app.main`). Best-effort: only bare
    ``name()`` calls are recognised, not ``module.name()``.
    """
    names = {"main"}
    for node in getattr(tree, "body", []):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if not (
            isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and test.left.id == "__name__"
            and any(isinstance(c, ast.Constant) and c.value == "__main__" for c in test.comparators)
        ):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                names.add(child.func.id)
    return names


def parse_python(source: str) -> ParseResult:
    tree = ast.parse(source)
    comments = _comment_lines(source)
    docstrings = _docstring_lines(tree)
    total = len(source.splitlines())

    blank = sum(1 for line in source.splitlines() if not line.strip())
    logical = total - blank - len(comments - docstrings) - len(docstrings)
    logical = max(0, logical)

    entrypoints = _entrypoint_names(tree)
    floors: list[Floor] = []
    symbols = 0
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            floor = _floor_from(node, "function", 0, ast.get_docstring(node) or "")
            floor.complexity = _complexity_of(node)
            floor.is_entrypoint = node.name in entrypoints
            floors.append(floor)
            symbols += 1
        elif isinstance(node, ast.ClassDef):
            floor = _floor_from(node, "class", 0, ast.get_docstring(node) or "")
            floor.complexity = _complexity_of(node)
            floors.append(floor)
            symbols += 1
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    method = _floor_from(child, "method", 1, ast.get_docstring(child) or "")
                    method.complexity = _complexity_of(child)
                    floors.append(method)
                    symbols += 1

    return ParseResult(
        language="python",
        logical_loc=logical,
        floors=floors,
        comment_lines=len(comments),
        doc_lines=len(comments | docstrings),
        confidence="high",
        imports=_imports_from(tree),
    )
