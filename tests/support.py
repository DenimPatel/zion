"""Shared test helpers.

Fixture repositories are built in a temp directory from a committed template,
so tests can inject the noise files that must be ignored (``build/``,
``debug.log``, ``.DS_Store``) without committing them into Zion itself, and can
create real git history with deterministic authors and dates.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
TINY_TEMPLATE = os.path.join(FIXTURES, "tiny-repo")

if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# The two external example repositories used for acceptance checks.
DEMO_SMALL = "/Users/denimpatel/Desktop/git/HARNESS/macro-harness"
DEMO_LARGE = "/Users/denimpatel/Desktop/git/interactive-courses"

NOISE_FILES = {
    "build/ignored.py": "def ignored():\n    return 'this file is gitignored'\n",
    "debug.log": "a log file that .gitignore excludes\n",
    ".DS_Store": "\x00\x01binary macos noise\x00",
    "beta/__pycache__/pipeline.cpython-311.pyc": "\x00\x00compiled\x00",
}


def _run(args: list[str], cwd: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, env=env
    )


def git_commit(
    repo: str,
    message: str,
    author: str = "Ada Lovelace",
    email: str = "ada@example.com",
    date: str = "2024-01-01T10:00:00+00:00",
) -> None:
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": author,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": author,
            "GIT_COMMITTER_EMAIL": email,
            "GIT_COMMITTER_DATE": date,
        }
    )
    _run(["add", "-A"], repo, env)
    _run(["commit", "-m", message, "--allow-empty"], repo, env)


def make_repo(
    directory: str,
    template: str = TINY_TEMPLATE,
    noise: bool = True,
    init: bool = True,
    commit: bool = True,
    authors: tuple[str, ...] = ("Ada Lovelace",),
    dates: tuple[str, ...] = ("2024-01-01T10:00:00+00:00",),
) -> str:
    """Materialise a fixture repo and return its path."""
    shutil.copytree(template, directory, dirs_exist_ok=True)
    if noise:
        for rel, content in NOISE_FILES.items():
            path = os.path.join(directory, rel)
            os.makedirs(os.path.dirname(path) or directory, exist_ok=True)
            with open(path, "w", encoding="utf-8", errors="replace") as fh:
                fh.write(content)
    if init:
        _run(["init", "-q"], directory)
        _run(["config", "user.email", "test@example.com"], directory)
        _run(["config", "user.name", "Test"], directory)
    if commit:
        for index in range(max(1, len(authors), len(dates))):
            author = authors[index % len(authors)]
            date = dates[index % len(dates)]
            if index:
                # Later commits must actually change files: a commit with no
                # numstat entries contributes nothing to authorship or coupling
                # and would silently weaken these tests.
                with open(os.path.join(directory, "alpha", "main.py"), "a", encoding="utf-8") as fh:
                    fh.write(f"\n# revision {index}\n")
                with open(os.path.join(directory, "README.md"), "a", encoding="utf-8") as fh:
                    fh.write(f"\nrevision {index}\n")
            git_commit(directory, f"commit {index + 1}", author=author, date=date)
    return directory


class TempRepoCase(unittest.TestCase):
    """Base class giving each test an isolated scratch directory."""

    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="zion-test-")
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)

    def scratch(self, name: str = "repo") -> str:
        return os.path.join(self._tmp, name)

    def build_city(self, repo_path: str, **kwargs):
        """Run the full pipeline and return (analysis, layout, emit_result)."""
        from analyzer import emit as emit_mod
        from analyzer.gitmeta import read_git_index
        from analyzer.layout import build_layout
        from analyzer.metrics import analyze
        from analyzer.walk import FileWalker

        include_noise = kwargs.pop("include_noise", False)
        walk = FileWalker(
            repo_path,
            include_noise=include_noise,
            max_buildings=kwargs.pop("max_buildings", None),
        ).walk()
        git = read_git_index(os.path.abspath(repo_path), {e.rel for e in walk.files})
        analysis = analyze(
            os.path.abspath(repo_path), walk.files, git, include_noise=include_noise
        )
        analysis.walk_source = walk.source
        analysis.noise_excluded = walk.noise_excluded
        layout = build_layout(analysis, kwargs.pop("district_depth", None))
        out_dir = kwargs.pop("out_dir", os.path.join(self._tmp, "city"))
        options = emit_mod.EmitOptions(**kwargs)
        result = emit_mod.emit_city(analysis, out_dir, options, layout=layout)
        return analysis, layout, result


def read_string_table(path: str) -> list[str]:
    """Decode ``strings.bin`` (plain mode only)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"ZIONSTR1":
        raise AssertionError(f"not a plain string table: {data[:8]!r}")
    count = struct.unpack("<I", data[8:12])[0]
    position = 12
    strings = []
    for _ in range(count):
        length = struct.unpack("<I", data[position : position + 4])[0]
        position += 4
        strings.append(data[position : position + length].decode("utf-8"))
        position += length
    return strings


def read_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def load_manifest(out_dir: str) -> dict:
    return read_json(os.path.join(out_dir, "city.json"))


def resolve(strings: list[str], index: int) -> str:
    if isinstance(index, int) and 0 <= index < len(strings):
        return strings[index]
    return ""
