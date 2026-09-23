"""Which source files have a test, and which risky ones do not.

A test is linked to the source files it exercises two ways, both best-effort:

- **imports**: a test file whose resolved imports reach a source file;
- **naming**: ``test_layout.py`` / ``layout_test.go`` / ``layout.test.ts`` /
  ``LayoutTest.java`` / ``layout.spec.js`` all name ``layout``. When several
  source files share the stem, the ones sharing the longest folder prefix with
  the test win.

An *untested* file is ordinary code with no test linked either way. That alone
is common and not alarming; the risk worth drawing is an untested file that is
also a hotspot, oversized or downtown -- the places a regression would cost the
most. The signal is gated on at least one test being linked at all, so a
repository whose tests the heuristics cannot read is not painted as untested.

Complexity bracing (S10 in docs/VISUALIZATION_ROADMAP.md) lives here too: a
file with one definition past ``BRACE_COMPLEXITY`` decision points is braced.
"""

from __future__ import annotations

import os
import re

from .health import _is_code

BRACE_COMPLEXITY = 15
# Languages that are markup, data or configuration rather than code with behaviour to test.
NOT_SOURCE = {
    "markdown", "text", "html", "css", "json", "jsonl", "yaml", "toml", "ini", "conf", "xml",
    "csv", "tsv", "data", "notebook", "docker", "make", "unknown",
}


def test_stem(name: str) -> str:
    """The source stem a test file's name points at, or "" if it names none."""
    parts = name.split(".")
    core = parts[0]
    if not core:
        return ""
    if any(p.lower() in ("test", "tests", "spec") for p in parts[1:-1]):
        return core.lower()  # layout.test.ts, layout.spec.js
    for pattern, flags in (
        (r"^tests?_(.+)$", re.IGNORECASE),  # test_layout.py
        (r"^(.+?)_(?:tests?|spec)$", re.IGNORECASE),  # layout_test.go
        (r"^(.+?[a-z0-9])(?:Tests?|Spec)$", 0),  # LayoutTest.java
    ):
        match = re.match(pattern, core, flags)
        if match:
            return match.group(1).lower()
    return ""


def _common_prefix(a: str, b: str) -> int:
    pa, pb = a.split("/")[:-1], b.split("/")[:-1]
    count = 0
    for x, y in zip(pa, pb):
        if x != y:
            break
        count += 1
    return count


def _is_source(record) -> bool:
    return (
        _is_code(record)
        and not record.is_test
        and not record.is_config
        and record.logical_loc > 0
        and record.language not in NOT_SOURCE
    )


def finalize_tests(analysis) -> None:
    files = analysis.files
    flags = analysis.flags
    by_rel = {f.rel: f for f in files}
    sources = [f for f in files if _is_source(f)]
    by_stem: dict[str, list] = {}
    for record in sources:
        by_stem.setdefault(os.path.splitext(record.name)[0].lower(), []).append(record)

    for record in files:
        record.tested_by = []
        record.is_tested = False
        record.is_untested = False
        record.untested_risk = False
        # Functions and methods only: a class's count is the sum of its methods
        # where the parser could not split them, which is not "one definition".
        record.brace_complexity = max(
            (int(fl.complexity) for fl in record.floors if fl.kind in ("function", "method")), default=0
        )
        record.is_braced = _is_code(record) and not record.is_test and record.brace_complexity >= BRACE_COMPLEXITY

    tests = [f for f in files if f.is_test and not f.is_binary and f.rows is None]
    for test in tests:
        linked: set[str] = set()
        for target in test.imports_resolved:
            other = by_rel.get(target)
            if other is not None and _is_source(other) and not target.endswith("__init__.py"):
                linked.add(target)
        stem = test_stem(test.name)
        # A name only links within one language: test_health.py is not about health.js.
        options = [o for o in by_stem.get(stem, ()) if o.language == test.language] if stem else []
        if options:
            best = max(_common_prefix(test.rel, o.rel) for o in options)
            linked.update(o.rel for o in options if _common_prefix(test.rel, o.rel) == best)
        for rel in linked:
            by_rel[rel].tested_by.append(test.rel)

    for record in sources:
        record.tested_by.sort()
        record.is_tested = bool(record.tested_by)
    flags.tests = any(r.is_tested for r in sources)
    if not tests:
        flags.notes.append("No test files found - test coverage links disabled.")
    elif not flags.tests:
        flags.notes.append("No test could be linked to a source file by import or name - untested markers disabled.")
    if flags.tests:
        for record in sources:
            record.is_untested = not record.is_tested
            record.untested_risk = record.is_untested and (record.is_hotspot or record.is_oversized or record.downtown)
    flags.complexity = any(r.is_braced for r in files)
