"""Generate a synthetic repository for scale testing.

The two reference repositories are small (28 and 357 files), so neither can show
whether the analyzer and viewer actually hold up. This builds a repository of a
requested size -- 50,000 files across ~2,000 nested directories by default --
with a scripted git history that exercises every metric family at once:
multiple authors, many active dates, real churn, and small commits that produce
co-change coupling without being bulk commits.

Everything is seeded, so two runs produce the same city.
"""

from __future__ import annotations

import argparse
import os
import random
import shutil
import subprocess
import sys
import time

AUTHORS = [
    ("Ada Lovelace", "ada@example.com"),
    ("Grace Hopper", "grace@example.com"),
    ("Alan Turing", "alan@example.com"),
]

TOP_LEVEL = ["core", "services", "adapters", "models", "pipelines", "tools", "apps", "libs"]

LANGUAGES = ["python", "javascript", "markdown", "json", "csv"]

PY_TEMPLATE = '''"""Module {module} in {folder}.

This docstring counts toward documentation coverage.
"""


class Handler{index}:
    """Handles one unit of work."""

    def __init__(self, name):
        self.name = name

    def run(self, payload):
        """Run the handler."""
        return {{"name": self.name, "payload": payload}}


def transform_{index}(value):
    # A comment, which is documentation too.
    return value * {index_plus}


def helper_{index}(value):
    return transform_{index}(value) + 1
'''

JS_TEMPLATE = """/* {module} — generated for scale testing. */
(function (global) {{
  "use strict";

  function make{index}(name) {{
    return {{ name: name, kind: "generated" }};
  }}

  const describe{index} = function (value) {{
    return value + "-{index}";
  }};

  global.make{index} = make{index};
  global.describe{index} = describe{index};
}})(window);
"""

MD_TEMPLATE = """# {module}

Generated documentation for `{folder}`.

## Usage

Call `transform_{index}(value)` and pass the result along.

## Notes

- {lines} lines of prose so the documentation ratio is measurable.
"""


def _python(index: int, module: str, folder: str) -> str:
    return PY_TEMPLATE.format(
        module=module,
        folder=folder,
        index=index,
        index_plus=(index % 9) + 1,
    )


def _javascript(index: int, module: str) -> str:
    return JS_TEMPLATE.format(index=index, module=module)


def _markdown(index: int, module: str, folder: str) -> str:
    return MD_TEMPLATE.format(module=module, folder=folder, index=index, lines=8 + index % 20)


def _json(index: int) -> str:
    rows = [{"id": i, "value": (i * index) % 997} for i in range(4 + index % 40)]
    return (
        '{"source":"generated dataset ' + str(index) + '","rows":'
        + __import__("json").dumps(rows, separators=(",", ":"))
        + "}"
    )


def _csv(index: int) -> str:
    lines = ["name,value"]
    for i in range(4 + index % 30):
        lines.append(f"row{i},{(i * index) % 101}")
    return "\n".join(lines) + "\n"


def _run_git(root: str, args: list[str], env: dict | None = None) -> None:
    result = subprocess.run(
        ["git", "-C", root, *args],
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")


def _author_env(index: int, day: int) -> dict:
    name, email = AUTHORS[index % len(AUTHORS)]
    date = f"2024-{(day % 12) + 1:02d}-{(day % 27) + 1:02d}T{9 + index % 9:02d}:00:00+00:00"
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": email,
            "GIT_COMMITTER_DATE": date,
        }
    )
    return env


def generate(
    target: str,
    files: int = 50000,
    directories: int | None = None,
    commits: int = 40,
    seed: int = 1234,
    quiet: bool = False,
) -> str:
    """Create the repository and return its path."""
    rng = random.Random(seed)
    directories = directories or max(1, files // 25)

    if os.path.exists(target):
        shutil.rmtree(target)
    os.makedirs(target)

    def log(message: str) -> None:
        if not quiet:
            print(message, flush=True)

    log(f"generating {files} files across ~{directories} directories ...")
    started = time.time()

    # Build a directory tree first, so files are spread across real nesting.
    folder_paths: list[str] = []
    for i in range(directories):
        top = TOP_LEVEL[i % len(TOP_LEVEL)]
        middle = f"group{(i // len(TOP_LEVEL)) % 40:02d}"
        leaf = f"unit{i % 97:03d}"
        folder_paths.append(os.path.join(top, middle, leaf))
    for rel in folder_paths:
        os.makedirs(os.path.join(target, rel), exist_ok=True)

    written: list[str] = []
    for i in range(files):
        folder = folder_paths[i % len(folder_paths)]
        language = LANGUAGES[i % len(LANGUAGES)]
        module = f"mod{i:05d}"
        if language == "python":
            name = f"{module}.py"
            body = _python(i, module, folder)
        elif language == "javascript":
            name = f"{module}.js"
            body = _javascript(i, module)
        elif language == "markdown":
            name = f"{module}.md"
            body = _markdown(i, module, folder)
        elif language == "json":
            name = f"{module}.json"
            body = _json(i)
        else:
            name = f"{module}.csv"
            body = _csv(i)
        rel = os.path.join(folder, name)
        with open(os.path.join(target, rel), "w", encoding="utf-8") as fh:
            fh.write(body)
        written.append(rel)

    # READMEs in a few folders, so the Town Hall signal is not degenerate.
    for index in range(0, len(folder_paths), max(1, len(folder_paths) // 12)):
        rel = os.path.join(folder_paths[index], "README.md")
        with open(os.path.join(target, rel), "w", encoding="utf-8") as fh:
            fh.write(f"# {folder_paths[index]}\n\nGenerated folder documentation.\n")
        written.append(rel)

    log(f"  wrote {len(written)} files in {time.time() - started:.1f}s")

    log("creating git history ...")
    _run_git(target, ["init", "-q"])
    _run_git(target, ["config", "user.email", "bench@example.com"])
    _run_git(target, ["config", "user.name", "Bench"])
    _run_git(target, ["config", "core.fscache", "true"])

    # One initial commit with everything, then many small commits. The initial
    # commit is deliberately bulk: it must be excluded from coupling.
    _run_git(target, ["add", "-A"])
    _run_git(target, ["commit", "-q", "-m", "initial import"], env=_author_env(0, 0))

    for c in range(1, commits):
        # Touch a small, overlapping set so coupling has something real to find.
        picks = [written[(c * 37 + k * 991) % len(written)] for k in range(6)]
        for rel in picks:
            with open(os.path.join(target, rel), "a", encoding="utf-8") as fh:
                fh.write(f"\n# revision {c}\n")
            _run_git(target, ["add", "--", rel])
        _run_git(target, ["commit", "-q", "-m", f"revision {c}"], env=_author_env(c, c * 3))

    log(f"  {commits} commits in {time.time() - started:.1f}s")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", default=os.path.join("bench", "tmp", "repo-50000"))
    parser.add_argument("--files", type=int, default=50000)
    parser.add_argument("--directories", type=int, default=None)
    parser.add_argument("--commits", type=int, default=40)
    parser.add_argument("--seed", type=int, default=1234)
    args = parser.parse_args(argv)

    path = generate(args.target, args.files, args.directories, args.commits, args.seed)
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
