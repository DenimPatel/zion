"""The third layer: blast radius, defects, debt, the main sequence, building
codes, external dependencies and the census.

Like `test_insights.py`, each test builds a small repository in which every
signal has exactly one right answer.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unittest

from support import ROOT, TempRepoCase, git_commit, read_bytes, read_json

from analyzer.parse.brace import parse_brace
from analyzer.parse.python_ast import parse_python
from analyzer.report import build_report, evaluate_gates, render_markdown


def _write(repo: str, rel: str, body: str) -> None:
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path) or repo, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)


def _init(repo: str) -> None:
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)


def _chain_repo(repo: str) -> str:
    """base <- mid <- top, base <- side; a test imports top; one TODO in base."""
    _init(repo)
    _write(repo, "lib/__init__.py", "")
    _write(repo, "lib/base.py", "# TODO: split this\ndef base():\n    return 1\n")
    _write(repo, "lib/mid.py", "from lib import base\n\ndef mid():\n    return base.base()\n")
    _write(repo, "app/__init__.py", "")
    _write(repo, "app/top.py", "from lib import mid\n\ndef top():\n    return mid.mid()\n")
    _write(repo, "app/side.py", "from lib import base\n\ndef side():\n    return base.base()\n")
    _write(repo, "tests/test_top.py", "from app import top\n\ndef test_top():\n    assert top.top() == 1\n")
    git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
    return repo


class ParserTests(unittest.TestCase):
    def test_python_debt_and_abstractness(self):
        result = parse_python(
            "import abc\nfrom typing import Protocol\n"
            "# TODO: one\n# FIXME and HACK here\n"
            "note = '# TODO inside a string is not debt'\n"
            "# a todo in lower case is prose\n"
            "class A(abc.ABC):\n    pass\n"
            "class P(Protocol):\n    pass\n"
            "class M:\n    @abc.abstractmethod\n    def f(self):\n        pass\n"
            "class C:\n    pass\n"
        )
        self.assertEqual(result.debt_markers, 3)
        self.assertEqual(result.class_count, 4)
        self.assertEqual(result.abstract_count, 3)

    def test_brace_debt_packages_and_interfaces(self):
        result = parse_brace(
            "import React from 'react';\n"
            "import { x } from \"@scope/pkg/deep\";\n"
            "import './local';\n"
            "const fs = require('node:fs');\n"
            "const s = '// TODO not a comment';\n"
            "// TODO fix this\n/* FIXME: and XXX */\n"
            "export interface Shape { area(): number }\n"
            "export abstract class Base { }\n"
            "export class Real extends Base { }\n",
            "typescript",
        )
        self.assertEqual(result.packages, ["react", "@scope/pkg", "node:fs"])
        self.assertEqual(result.imports, ["./local"])
        self.assertEqual(result.debt_markers, 3)
        self.assertEqual(result.class_count, 3)
        self.assertEqual(result.abstract_count, 2)


class ImpactTests(TempRepoCase):
    def test_blast_radius_is_transitive_and_leaves_out_tests(self):
        analysis, _layout, result = self.build_city(_chain_repo(self.scratch()))
        by_rel = {f.rel: f for f in analysis.files}
        # base <- mid, side; mid <- top. The test that imports top is not counted.
        self.assertEqual(by_rel["lib/base.py"].impact, 3)
        self.assertEqual(by_rel["lib/base.py"].impact_folders, 2)
        self.assertEqual(by_rel["lib/mid.py"].impact, 1)
        self.assertEqual(by_rel["app/top.py"].impact, 0)
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        columns = manifest["indexColumns"]
        self.assertEqual(columns[-3:], ["impact", "fixes", "debt"])
        index = read_json(os.path.join(result.out_dir, "index.json"))
        rows = {row[columns.index("id")]: row for row in index}
        base_id = next(
            row[columns.index("id")] for row in index if row[columns.index("loc")] and row[columns.index("impact")] == 3
        )
        self.assertEqual(rows[base_id][columns.index("debt")], 1)
        self.assertTrue(analysis.flags.debt)
        legend = {e["id"]: e["enabled"] for e in manifest["legend"]}
        self.assertTrue(legend["impact"])
        self.assertTrue(legend["debt"])


class DefectTests(TempRepoCase):
    def test_fix_commits_mark_the_bug_prone_file(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "src/fragile.py", "def f():\n    return 0\n")
        _write(repo, "src/steady.py", "def g():\n    return 0\n")
        for i in range(8):
            _write(repo, f"src/other{i}.py", f"def h{i}():\n    return {i}\n")
        git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
        subjects = ["Fix off-by-one", "fix: crash on empty", "Revert \"add cache\"", "hotfix for login"]
        for day, subject in enumerate(subjects, start=2):
            _write(repo, "src/fragile.py", f"def f():\n    return {day}\n")
            _write(repo, "src/steady.py", f"def g():\n    return {day}\n\n\ndef g{day}():\n    return 0\n")
            git_commit(repo, subject, date=f"2024-01-{day:02d}T10:00:00+00:00")
            # steady.py also changes in feature commits of its own.
            _write(repo, "src/steady.py", f"def g():\n    return {day * 10}\n")
            _write(repo, "src/other0.py", f"def h0():\n    return {day}\n")
            git_commit(repo, f"add feature {day}", date=f"2024-01-{day:02d}T12:00:00+00:00")
        analysis, _layout, result = self.build_city(repo)
        by_rel = {f.rel: f for f in analysis.files}
        fragile = by_rel["src/fragile.py"]
        self.assertTrue(analysis.flags.defects)
        self.assertEqual(fragile.fix_commits, 3)
        self.assertEqual(fragile.revert_commits, 1)
        self.assertTrue(fragile.is_bugprone)
        # other0.py only ever changed in feature commits.
        self.assertEqual(by_rel["src/other0.py"].fix_commits, 0)
        self.assertFalse(by_rel["src/other0.py"].is_bugprone)
        self.assertEqual(analysis.git.revert_commits, 1)
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        self.assertEqual(len(manifest["review"]["bugprone"]), 1)
        self.assertEqual(manifest["review"]["totals"]["bugprone"], sum(1 for f in analysis.files if f.is_bugprone))

    def test_no_fix_subjects_disables_the_signal(self):
        analysis, _layout, _result = self.build_city(_chain_repo(self.scratch()))
        self.assertFalse(analysis.flags.defects)
        self.assertFalse(any(f.is_bugprone for f in analysis.files))
        self.assertTrue(any("bug-prone" in note for note in analysis.flags.notes))


def _zones_repo(repo: str) -> str:
    """`core` holds concrete classes that three other folders import: pain.
    `api` holds only protocols and nothing imports it, while it imports core:
    uselessness."""
    _init(repo)
    _write(repo, "core/__init__.py", "")
    _write(repo, "core/model.py", "class Order:\n    pass\n\n\nclass Line:\n    pass\n")
    for name in ("web", "jobs", "cli"):
        _write(repo, f"{name}/__init__.py", "")
        _write(repo, f"{name}/main.py", "from core import model\n\n\ndef run():\n    return model.Order()\n")
    _write(repo, "api/__init__.py", "")
    _write(
        repo,
        "api/ports.py",
        "from typing import Protocol\nfrom core import model\n\n\nclass Repo(Protocol):\n    pass\n\n\n"
        "class Bus(Protocol):\n    pass\n\n\nclass Clock(Protocol):\n    pass\n",
    )
    git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
    return repo


class MainSequenceTests(TempRepoCase):
    def test_zones_of_pain_and_uselessness(self):
        analysis, layout, result = self.build_city(_zones_repo(self.scratch()), district_depth=1)
        districts = analysis.architecture.districts
        core = districts["core"]
        self.assertEqual((core.classes, core.abstract), (2, 0))
        self.assertEqual(core.abstractness, 0.0)
        self.assertEqual(core.instability, 0.0)
        self.assertEqual(core.distance, 1.0)
        self.assertEqual(core.zone, "pain")
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        rows = {manifest["districts"][r[0]]["zone"] for r in manifest["mainSequence"]}
        self.assertIn("pain", rows)
        report = build_report(analysis, layout)
        self.assertEqual(report["totals"]["zonePain"], 1)
        failures, _skipped = evaluate_gates(report, ["zone-of-pain"])
        self.assertTrue(failures)
        self.assertIn("zone of pain", render_markdown(report))


class BuildingCodeTests(TempRepoCase):
    def test_declared_codes_are_enforced_per_path(self):
        repo = _chain_repo(self.scratch())
        big = "".join(f"def f{i}():\n    return {i}\n\n" for i in range(12))
        _write(repo, "app/big.py", big)
        _write(
            repo,
            ".zion/rules.json",
            json.dumps({"codes": [{"max_loc": 20}, {"paths": "lib/**", "max_loc": 1, "max_debt": 0}]}),
        )
        git_commit(repo, "codes", date="2024-01-02T10:00:00+00:00")
        analysis, layout, result = self.build_city(repo)
        by_rel = {f.rel: f for f in analysis.files}
        self.assertTrue(analysis.flags.codes)
        self.assertEqual(by_rel["app/big.py"].code_violations, ["max_loc: 24 logical lines > 20"])
        self.assertIn("max_debt: 1 debt markers > 0", by_rel["lib/base.py"].code_violations)
        self.assertEqual(by_rel["app/top.py"].code_violations, [])
        self.assertEqual(by_rel["tests/test_top.py"].code_violations, [])  # tests are exempt
        index = read_json(os.path.join(result.out_dir, "index.json"))
        flags_col = read_json(os.path.join(result.out_dir, "city.json"))["indexColumns"].index("flags")
        self.assertEqual(sum(1 for row in index if row[flags_col] & (1 << 25)), sum(1 for f in analysis.files if f.code_violations))
        report = build_report(analysis, layout)
        self.assertTrue(evaluate_gates(report, ["codes"])[0])
        self.assertIn("Building-code breaches", render_markdown(report))

    def test_codes_only_rules_keep_the_majority_layering(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "a/__init__.py", "")
        _write(repo, "a/one.py", "from b import two\n\ndef one():\n    return two.two()\n")
        _write(repo, "a/three.py", "from b import two\n\ndef three():\n    return two.two()\n")
        _write(repo, "b/__init__.py", "")
        _write(repo, "b/two.py", "from a import one\n\ndef two():\n    return 2\n")
        _write(repo, ".zion/rules.json", json.dumps({"codes": {"max_loc": 1000}}))
        git_commit(repo, "initial")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        self.assertEqual(analysis.architecture.rules, "majority")
        self.assertEqual([(s, d) for s, d, _ in analysis.architecture.violations], [("b/two.py", "a/one.py")])

    def test_no_codes_declared_says_so(self):
        analysis, _layout, _result = self.build_city(_chain_repo(self.scratch()))
        self.assertFalse(analysis.flags.codes)
        notes = [n for n in analysis.flags.notes if "building codes" in n]
        self.assertEqual(len(notes), 1)  # stated once, though the layout runs twice


def _trade_repo(repo: str) -> str:
    _init(repo)
    _write(repo, "requirements.txt", "requests>=2\nunusedpkg==1.0\npytest\n# a comment\n")
    _write(repo, "package.json", json.dumps({"dependencies": {"react": "18", "lodash": "4"}, "devDependencies": {"typescript": "5"}}))
    _write(repo, "svc/__init__.py", "")
    _write(repo, "svc/client.py", "import os\nimport requests\nimport yaml\nfrom svc import util\n\ndef get():\n    return requests.get\n")
    _write(repo, "svc/util.py", "import requests\n\ndef u():\n    return 1\n")
    _write(repo, "web/app.js", "import React from 'react';\nimport { thing } from '@acme/ui/button';\nimport './local';\nconst p = require('path');\n")
    _write(repo, "web/local.js", "export const x = 1;\n")
    git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
    return repo


class ExternalTests(TempRepoCase):
    def test_packages_undeclared_and_unused(self):
        analysis, layout, result = self.build_city(_trade_repo(self.scratch()))
        ext = analysis.externals
        names = {p["name"]: p for p in ext["packages"]}
        self.assertEqual(names["requests"]["files"], 2)
        self.assertTrue(names["requests"]["declared"])
        self.assertIn("pyyaml", names)  # `import yaml` is the pyyaml distribution
        self.assertNotIn("os", names)  # standard library
        self.assertNotIn("svc", names)  # the repository's own package
        self.assertNotIn("path", names)  # a node builtin
        self.assertEqual(ext["undeclared"], ["@acme/ui", "pyyaml"])
        self.assertEqual(ext["unused"], ["lodash", "unusedpkg"])  # pytest and typescript are tools
        self.assertEqual(ext["manifests"], ["package.json", "requirements.txt"])
        by_rel = {f.rel: f for f in analysis.files}
        self.assertEqual(by_rel["svc/client.py"].packages, ["requests", "pyyaml"])
        self.assertEqual(by_rel["web/app.js"].packages, ["react", "@acme/ui"])
        report = build_report(analysis, layout)
        self.assertEqual(report["totals"]["undeclared"], 2)
        self.assertTrue(evaluate_gates(report, ["undeclared-dep"])[0])
        self.assertIn("## External dependencies", render_markdown(report))

    def test_package_names_are_encrypted(self):
        repo = _trade_repo(self.scratch())
        out = os.path.join(self._tmp, "locked")
        self.build_city(repo, out_dir=out, encrypt=True, passphrase="p")
        for rel in ("city.json", "index.json", "summary.json", "census.json"):
            raw = read_bytes(os.path.join(out, rel))
            for probe in (b"requests", b"pyyaml", b"@acme", b"lodash"):
                self.assertNotIn(probe, raw, f"{probe!r} leaked into {rel}")
        chunks = os.path.join(out, "d")
        for name in os.listdir(chunks):
            self.assertNotIn(b"requests", read_bytes(os.path.join(chunks, name)))


class CensusTests(TempRepoCase):
    def test_census_keeps_one_entry_per_commit(self):
        repo = _chain_repo(self.scratch())
        out = os.path.join(self._tmp, "city")
        self.build_city(repo, out_dir=out)
        self.build_city(repo, out_dir=out)  # same head: replaced, not appended
        census = read_json(os.path.join(out, "census.json"))
        self.assertEqual(len(census["entries"]), 1)
        _write(repo, "lib/more.py", "# TODO later\n# FIXME too\ndef more():\n    return 2\n")
        git_commit(repo, "more", date="2024-02-01T10:00:00+00:00")
        _analysis, _layout, result = self.build_city(repo, out_dir=out)
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        self.assertEqual(len(manifest["census"]), 2)
        self.assertEqual([e["totals"]["debt"] for e in manifest["census"]], [1, 3])
        self.assertNotIn(b"lib/", read_bytes(os.path.join(out, "census.json")))


class MirrorTests(unittest.TestCase):
    def test_viewer_flag_bits_and_legend_rows_match_the_emitter(self):
        from analyzer import emit

        facets = open(os.path.join(ROOT, "viewer", "js", "facets.js"), encoding="utf-8").read()
        for name, bit in (("bugprone", emit.FLAG_BUGPRONE), ("debt", emit.FLAG_DEBT), ("codes", emit.FLAG_CODES)):
            match = re.search(rf"\b{name}: 1 << (\d+)", facets)
            self.assertIsNotNone(match, name)
            self.assertEqual(1 << int(match.group(1)), bit, name)
        main = open(os.path.join(ROOT, "viewer", "js", "main.js"), encoding="utf-8").read()
        keys = main[main.index("const LEGEND_KEYS = {") : main.index("};", main.index("const LEGEND_KEYS = {"))]
        for entry in emit.LEGEND_SPEC:
            self.assertRegex(keys, rf"\n  {entry[0]}: \{{", f"LEGEND_KEYS has no row for {entry[0]}")


if __name__ == "__main__":
    unittest.main()
