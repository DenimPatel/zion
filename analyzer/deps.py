"""External trade: the third-party packages a repository leans on.

`metrics._finalize_downtown` resolves imports that point at files in the
repository. Everything left over is trade with the outside world: the
standard library (not interesting) and third-party packages (very
interesting to an architect -- which parts depend on which libraries, and
whether the manifests say so).

Two ecosystems are read, because they are the two whose imports the parsers
collect: Python (`import x`, from `python_ast`) against `requirements*.txt` and
`pyproject.toml`, and JavaScript/TypeScript (bare specifiers, from `brace`)
against `package.json`. For each package: how many files import it and from
how many folders, and whether a manifest declares it. Per ecosystem, and only
when that ecosystem has a manifest at all:

- **undeclared**: imported but not declared -- it works on the author's machine;
- **unused**: declared but never imported -- dead weight, or a plugin/CLI
  loaded by name (so this is a question, never a verdict).

Manifests are read, never written. Tests count as importers: a package only
the tests use is still used, and belongs in the dev dependencies. Tools that
are run rather than imported (linters, test runners, bundlers, servers) are
never called unused.
"""

from __future__ import annotations

import fnmatch
import functools
import json
import os
import re
import sys
from dataclasses import dataclass, field

from .health import is_vendored

MAX_PACKAGES = 40

# Import name -> distribution name, for the common packages where they differ.
PY_ALIASES = {
    "yaml": "pyyaml", "pil": "pillow", "sklearn": "scikit-learn", "bs4": "beautifulsoup4",
    "cv2": "opencv-python", "dateutil": "python-dateutil", "jwt": "pyjwt", "dotenv": "python-dotenv",
    "attr": "attrs", "openssl": "pyopenssl", "crypto": "pycryptodome", "magic": "python-magic",
    "serial": "pyserial", "git": "gitpython", "docx": "python-docx", "pptx": "python-pptx",
    "zmq": "pyzmq", "skimage": "scikit-image", "google.protobuf": "protobuf", "multipart": "python-multipart",
    "jose": "python-jose", "slugify": "python-slugify", "psycopg2": "psycopg2-binary",
}
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
    "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream",
    "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib",
}
# `sys.stdlib_module_names` is Python 3.10+; the fallback keeps a 3.9 build
# from mistaking the standard library for third-party trade.
_FALLBACK_STDLIB = {
    "abc", "argparse", "array", "ast", "asyncio", "base64", "binascii", "bisect", "builtins", "bz2",
    "calendar", "cmath", "codecs", "collections", "concurrent", "configparser", "contextlib", "copy", "csv",
    "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email", "enum", "errno", "fnmatch",
    "fractions", "ftplib", "functools", "gc", "getpass", "gettext", "glob", "gzip", "hashlib", "heapq",
    "hmac", "html", "http", "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword",
    "linecache", "locale", "logging", "lzma", "math", "mimetypes", "multiprocessing", "numbers", "operator",
    "os", "pathlib", "pickle", "pkgutil", "platform", "plistlib", "pprint", "queue", "random", "re",
    "readline", "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtplib",
    "socket", "socketserver", "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess", "sys",
    "sysconfig", "tarfile", "tempfile", "textwrap", "threading", "time", "timeit", "token", "tokenize",
    "traceback", "tracemalloc", "types", "typing", "unicodedata", "unittest", "urllib", "uuid", "venv",
    "warnings", "wave", "weakref", "webbrowser", "xml", "xmlrpc", "zipfile", "zipimport", "zlib", "zoneinfo",
}
_stdlib = getattr(sys, "stdlib_module_names", None)
PY_STDLIB = (set(_stdlib) if _stdlib is not None else _FALLBACK_STDLIB) | {"__future__"}
# Namespace packages whose distribution name is the first three segments.
PY_NAMESPACES = {"google", "azure"}
# Declared to be run, not imported: never "unused".
TOOLS = (
    "pytest*", "black", "ruff", "flake8*", "mypy", "isort", "pre-commit", "coverage", "tox", "nox", "pylint",
    "sphinx*", "twine", "build", "wheel", "setuptools*", "pip", "hatch*", "poetry*", "flit*", "uvicorn",
    "gunicorn", "ipykernel", "jupyter*", "eslint*", "@eslint/*", "prettier*", "typescript", "@types/*",
    "types-*", "jest*", "vitest", "webpack*", "vite", "@vitejs/*", "babel*", "@babel/*", "ts-node", "tsx",
    "nodemon", "husky", "lint-staged", "rollup*", "@rollup/*", "esbuild", "concurrently", "rimraf",
    "@typescript-eslint/*", "stylelint*", "postcss*", "autoprefixer", "tailwindcss", "playwright",
    "@playwright/*", "cypress",
)


@functools.lru_cache(maxsize=65536)
def normalize(name: str) -> str:
    """PEP 503 normalisation, also good enough to compare npm names."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


@dataclass
class Package:
    name: str
    ecosystem: str  # "python" | "npm"
    files: set[str] = field(default_factory=set)
    declared: bool = False


# --------------------------------------------------------------------------
# Manifests
# --------------------------------------------------------------------------

_REQ_LINE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _requirements(text: str) -> set[str]:
    names = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith(("-", "git+", "http:", "https:")):
            continue
        match = _REQ_LINE.match(line)
        if match:
            names.add(normalize(match.group(1)))
    return names


def _pyproject(text: str) -> set[str]:
    try:
        import tomllib
    except ImportError:  # pragma: no cover - Python < 3.11
        return set()
    try:
        data = tomllib.loads(text)
    except (tomllib.TOMLDecodeError, ValueError):
        return set()
    names: set[str] = set()
    project = data.get("project") or {}
    specs = list(project.get("dependencies") or [])
    for group in (project.get("optional-dependencies") or {}).values():
        specs.extend(group or [])
    for group in (data.get("dependency-groups") or {}).values():
        specs.extend(s for s in group or [] if isinstance(s, str))
    for spec in specs:
        if isinstance(spec, str):
            match = _REQ_LINE.match(spec)
            if match:
                names.add(normalize(match.group(1)))
    poetry = (data.get("tool") or {}).get("poetry") or {}
    tables = [poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}]
    for group in (poetry.get("group") or {}).values():
        tables.append((group or {}).get("dependencies") or {})
    for table in tables:
        names.update(normalize(key) for key in table if key.lower() != "python")
    return names


def _package_json(text: str) -> set[str]:
    try:
        data = json.loads(text)
    except ValueError:
        return set()
    if not isinstance(data, dict):
        return set()
    names: set[str] = set()
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        table = data.get(key)
        if isinstance(table, dict):
            names.update(normalize(k) for k in table)
    return names


def _read(path: str, limit: int = 2_000_000) -> str:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""


def _manifests(files) -> tuple[dict[str, set[str]], list[str]]:
    """Declared names per ecosystem, and the manifest paths that declared them."""
    declared: dict[str, set[str]] = {}
    paths: list[str] = []
    for record in files:
        if is_vendored(record.rel) or "node_modules/" in record.rel:
            continue
        name = record.name.lower()
        if name.startswith("requirements") and name.endswith((".txt", ".in")):
            ecosystem, names = "python", _requirements(_read(record.abspath))
        elif name == "pyproject.toml":
            ecosystem, names = "python", _pyproject(_read(record.abspath))
        elif name == "package.json":
            ecosystem, names = "npm", _package_json(_read(record.abspath))
        else:
            continue
        declared.setdefault(ecosystem, set()).update(names)
        paths.append(record.rel)
    return declared, sorted(paths)


# --------------------------------------------------------------------------
# Imports
# --------------------------------------------------------------------------


def _local_names(files) -> set[str]:
    """Every folder and module name in the repository: an import of one of
    these is this repository's own code (a `src/` layout, a sibling package),
    never a third-party package."""
    raw: set[str] = set()
    for record in files:
        parts = record.rel.split("/")
        raw.update(parts[:-1])
        raw.add(os.path.splitext(parts[-1])[0])
    raw.discard("")
    return {normalize(name) for name in raw}


def _python_package(spec: str, local: set[str]) -> str:
    if not spec or spec.startswith("."):
        return ""
    parts = spec.split(".")
    top = parts[0]
    if top in PY_STDLIB or normalize(top) in local:
        return ""
    if top in PY_NAMESPACES and len(parts) >= 3:
        return normalize(".".join(parts[:3]))
    two = ".".join(parts[:2]).lower()
    return PY_ALIASES.get(two) or PY_ALIASES.get(top.lower()) or top


def _npm_package(name: str, local: set[str]) -> str:
    if not name or name.startswith(("node:", "@/", "~", "#")):
        return ""
    if name in NODE_BUILTINS or normalize(name) in local:
        return ""
    return name


def finalize_deps(analysis) -> None:
    """Fill every file's `packages` and `analysis.externals`."""
    files = analysis.files
    local = _local_names(files)
    packages: dict[tuple[str, str], Package] = {}

    for record in files:
        found: list[tuple[str, str]] = []
        if record.language == "python":
            for spec in record.raw_imports:
                name = _python_package(spec, local)
                if name:
                    found.append(("python", name))
        for name in record.packages:  # bare specifiers from the brace parser
            name = _npm_package(name, local)
            if name:
                found.append(("npm", name))
        names: list[str] = []
        for ecosystem, name in found:
            key = (ecosystem, normalize(name))
            package = packages.setdefault(key, Package(name=name, ecosystem=ecosystem))
            package.files.add(record.rel)
            if name not in names:
                names.append(name)
        record.packages = names

    declared, manifests = _manifests(files)
    undeclared: list[str] = []
    for (ecosystem, key), package in packages.items():
        package.declared = key in declared.get(ecosystem, ())
        # Only an ecosystem with a manifest can be missing something from it.
        if ecosystem in declared and not package.declared:
            undeclared.append(package.name)
    imported = {key for key in packages}
    unused = sorted(
        name
        for ecosystem, names in declared.items()
        for name in names
        if (ecosystem, name) not in imported
        and not any(fnmatch.fnmatch(name, pattern) for pattern in TOOLS)
    )

    ranked = sorted(packages.values(), key=lambda p: (-len(p.files), p.name.lower()))
    analysis.externals = {
        "packages": [
            {
                "name": p.name,
                "ecosystem": p.ecosystem,
                "files": len(p.files),
                "folders": len({f.rsplit("/", 1)[0] if "/" in f else "" for f in p.files}),
                "declared": p.declared,
            }
            for p in ranked[:MAX_PACKAGES]
        ],
        "total": len(packages),
        "undeclared": sorted(undeclared, key=str.lower),
        "unused": unused,
        "manifests": manifests,
    }
    analysis.flags.externals = bool(packages)
    if not packages:
        analysis.flags.notes.append("No third-party package imports found - the harbour is empty.")
