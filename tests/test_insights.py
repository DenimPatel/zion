"""The next layer of architect's signals: structure, ownership, tests, change.

Each test builds a small repository where every signal has exactly one right
answer, the same way `test_health.py` does for the first layer.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

from support import ROOT, TempRepoCase, git_commit, read_bytes, read_json

from analyzer.owners import owners_for, parse_codeowners, resolve_owner
from analyzer.report import build_report, evaluate_gates, render_markdown
from analyzer.testmap import test_stem as stem_of


def _write(repo: str, rel: str, body: str) -> None:
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path) or repo, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)


def _init(repo: str) -> None:
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)


def _layered_repo(repo: str) -> str:
    """ui -> app -> core, plus one import from core back up into app."""
    _init(repo)
    _write(repo, "core/__init__.py", "")
    _write(repo, "core/model.py", "def entity():\n    return 1\n")
    _write(repo, "core/rules.py", "from app import service\n\ndef rule():\n    return service.run()\n")
    _write(repo, "app/__init__.py", "")
    _write(repo, "app/service.py", "from core import model\n\ndef run():\n    return model.entity()\n")
    _write(repo, "app/jobs.py", "from core import model\n\ndef job():\n    return model.entity()\n")
    _write(repo, "ui/__init__.py", "")
    _write(repo, "ui/view.py", "from app import service\n\ndef show():\n    return service.run()\n")
    _write(repo, "tests/test_service.py", "from app import service\n\ndef test_run():\n    assert service.run() == 1\n")
    git_commit(repo, "initial", author="Ada Lovelace", email="ada@example.com", date="2024-01-01T10:00:00+00:00")
    return repo


class ArchitectureTests(TempRepoCase):
    def test_folder_coupling_and_instability(self):
        analysis, layout, _result = self.build_city(_layered_repo(self.scratch()), district_depth=1)
        arch = analysis.architecture
        self.assertEqual(arch.rules, "majority")
        # core is imported by app (service, jobs) and imports app once (rules.py).
        core = arch.districts["core"]
        self.assertEqual(core.ca, 2)
        self.assertEqual(core.ce, 1)
        self.assertAlmostEqual(core.instability, 1 / 3, places=3)
        ui = arch.districts["ui"]
        self.assertEqual((ui.ca, ui.ce, ui.instability), (0, 1, 1.0))
        # Tests do not count as design dependencies.
        self.assertNotIn(("tests", "app"), arch.matrix)
        self.assertEqual(arch.matrix[("app", "core")], 2)

    def test_majority_rule_flags_the_thinner_direction(self):
        analysis, _layout, _result = self.build_city(_layered_repo(self.scratch()), district_depth=1)
        violations = [(src, dst) for src, dst, _ in analysis.architecture.violations]
        self.assertEqual(violations, [("core/rules.py", "app/service.py")])
        by_rel = {f.rel: f for f in analysis.files}
        self.assertTrue(by_rel["core/rules.py"].is_violation)
        self.assertFalse(by_rel["app/service.py"].is_violation)
        self.assertTrue(analysis.flags.layering)

    def test_rules_file_layers_and_forbid(self):
        repo = _layered_repo(self.scratch())
        _write(repo, ".zion/rules.json", json.dumps({"layers": ["ui", "app", "core"], "forbid": [["ui", "core"]]}))
        _write(repo, "ui/direct.py", "from core import model\n\ndef peek():\n    return model.entity()\n")
        git_commit(repo, "rules", date="2024-01-02T10:00:00+00:00")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        arch = analysis.architecture
        self.assertEqual(arch.rules, ".zion/rules.json")
        found = {(src, dst): reason for src, dst, reason in arch.violations}
        self.assertIn(("core/rules.py", "app/service.py"), found)
        self.assertIn("layer 3 imports layer 2", found[("core/rules.py", "app/service.py")])
        self.assertIn(("ui/direct.py", "core/model.py"), found)
        self.assertTrue(found[("ui/direct.py", "core/model.py")].startswith("forbidden"))
        # Downward imports are fine under the rules.
        self.assertNotIn(("app/service.py", "core/model.py"), found)

    def test_import_edges_are_emitted_by_id_and_match_when_encrypted(self):
        repo = _layered_repo(self.scratch())
        _, _, plain = self.build_city(repo, district_depth=1, out_dir=os.path.join(self._tmp, "plain"))
        _, _, locked = self.build_city(
            repo, district_depth=1, out_dir=os.path.join(self._tmp, "locked"), encrypt=True, passphrase="p"
        )
        edges = read_json(os.path.join(plain.out_dir, "imports.json"))
        self.assertTrue(edges)
        self.assertTrue(all(len(e) == 3 and e[2] in (0, 1) for e in edges))
        self.assertEqual(sum(e[2] for e in edges), 1)
        self.assertEqual(read_bytes(os.path.join(plain.out_dir, "imports.json")),
                         read_bytes(os.path.join(locked.out_dir, "imports.json")))
        manifest = read_json(os.path.join(plain.out_dir, "city.json"))
        self.assertEqual(manifest["imports"], "imports.json")
        deps = manifest["dependencies"]
        self.assertEqual(deps["violations"], 1)
        self.assertEqual(len(deps["violatingPairs"]), 1)
        legend = {e["id"]: e for e in manifest["legend"]}
        for key in ("imports", "instability", "violations", "district_coupling", "untested", "complexity",
                    "codeowners", "experts", "delta", "timeline"):
            self.assertIn(key, legend)
        self.assertTrue(legend["violations"]["enabled"])
        district = next(d for d in manifest["districts"] if d["ca"] or d["ce"])
        for field in ("ca", "ce", "instability", "violations", "activity", "experts", "testedFiles", "sourceFiles"):
            self.assertIn(field, district)


class OwnershipTests(TempRepoCase):
    def test_codeowners_patterns_follow_gitignore_semantics(self):
        rules = parse_codeowners(
            "# comment\n*.js @web\n/docs/ @writers\napp/ @ada\napp/legacy/** @old-team/owners\nREADME.md\n"
        )
        self.assertEqual(owners_for("src/index.js", rules), ["@web"])
        self.assertEqual(owners_for("docs/guide.md", rules), ["@writers"])
        self.assertIsNone(owners_for("src/docs/guide.md", rules))
        self.assertEqual(owners_for("app/main.py", rules), ["@ada"])
        self.assertEqual(owners_for("lib/app/x.py", rules), ["@ada"])  # unanchored folder
        self.assertEqual(owners_for("app/legacy/old.py", rules), ["@old-team/owners"])
        self.assertEqual(owners_for("README.md", rules), [])  # explicitly unowned
        self.assertIsNone(owners_for("setup.py", rules))

    def test_owner_resolution(self):
        keys = {"adalovelace": "Ada Lovelace", "ada": "Ada Lovelace", "grace": "Grace Hopper"}
        self.assertEqual(resolve_owner("@ada", keys), "Ada Lovelace")
        self.assertEqual(resolve_owner("@AdaLovelace", keys), "Ada Lovelace")
        self.assertIsNone(resolve_owner("@org/team", keys))
        self.assertIsNone(resolve_owner("@nobody", keys))

    def _owned_repo(self) -> str:
        repo = self.scratch()
        _init(repo)
        _write(repo, "CODEOWNERS", "* @grace\nlib/ @ada\n")
        _write(repo, "lib/core.py", "".join(f"def core{i}():\n    return {i}\n\n" for i in range(8)))
        _write(repo, "app/main.py", "def main():\n    return 2\n")
        git_commit(repo, "ada writes lib", author="Ada Lovelace", email="ada@example.com", date="2023-01-01T10:00:00+00:00")
        # Grace, whom CODEOWNERS names for app/, never writes app/main.py;
        # she does commit elsewhere, so she resolves to a real author.
        _write(repo, "app/main.py", "def main():\n    return 3\n\ndef extra():\n    return 4\n")
        git_commit(repo, "ada writes app", author="Ada Lovelace", email="ada@example.com", date="2023-02-01T10:00:00+00:00")
        _write(repo, "notes.md", "# notes\n")
        git_commit(repo, "grace", author="Grace Hopper", email="grace@example.com", date="2024-06-01T10:00:00+00:00")
        with open(os.path.join(repo, "lib/core.py"), "a", encoding="utf-8") as fh:
            fh.write("".join(f"def more{i}():\n    return {i}\n\n" for i in range(3)))
        git_commit(repo, "grace touches lib", author="Grace Hopper", email="grace@example.com", date="2024-06-02T10:00:00+00:00")
        return repo

    def test_drift_and_experts(self):
        analysis, _layout, _result = self.build_city(self._owned_repo())
        by_rel = {f.rel: f for f in analysis.files}
        self.assertTrue(analysis.flags.codeowners)
        self.assertEqual(by_rel["app/main.py"].declared_owners, ["@grace"])
        self.assertTrue(by_rel["app/main.py"].owner_drift)
        self.assertFalse(by_rel["lib/core.py"].owner_drift)  # @ada wrote most of it
        # Ada wrote most of lib/core.py (24 lines to 9), but Grace touched it
        # eighteen months later: halved every six months, Ada's 24 lines count
        # for about 3 today against Grace's 9, so Grace is the one to ask.
        experts = [name for name, _ in by_rel["lib/core.py"].experts]
        self.assertEqual(experts[0], "Grace Hopper")
        shares = dict(by_rel["lib/core.py"].author_shares)
        self.assertGreater(shares["Ada Lovelace"], shares["Grace Hopper"])

    def test_no_codeowners_means_no_drift(self):
        analysis, _layout, result = self.build_city(_layered_repo(self.scratch()))
        self.assertFalse(analysis.flags.codeowners)
        self.assertFalse(any(f.owner_drift or f.is_unowned for f in analysis.files))
        legend = {e["id"]: e["enabled"] for e in read_json(os.path.join(result.out_dir, "city.json"))["legend"]}
        self.assertFalse(legend["codeowners"])


class TestLinkTests(TempRepoCase):
    def test_stems(self):
        self.assertEqual(stem_of("test_layout.py"), "layout")
        self.assertEqual(stem_of("layout_test.go"), "layout")
        self.assertEqual(stem_of("layout.test.ts"), "layout")
        self.assertEqual(stem_of("LayoutTest.java"), "layout")
        self.assertEqual(stem_of("conftest.py"), "")
        self.assertEqual(stem_of("test_latest.py"), "latest")

    def test_links_by_import_and_by_name(self):
        repo = _layered_repo(self.scratch())
        _write(repo, "tests/test_model.py", "def test_nothing():\n    assert True\n")
        git_commit(repo, "name-only test", date="2024-01-02T10:00:00+00:00")
        analysis, _layout, _result = self.build_city(repo)
        by_rel = {f.rel: f for f in analysis.files}
        self.assertTrue(analysis.flags.tests)
        self.assertEqual(by_rel["app/service.py"].tested_by, ["tests/test_service.py"])  # import
        self.assertEqual(by_rel["core/model.py"].tested_by, ["tests/test_model.py"])  # name
        self.assertTrue(by_rel["ui/view.py"].is_untested)
        self.assertFalse(by_rel["tests/test_service.py"].is_untested)

    def test_no_linkable_tests_disables_the_signal(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "a.py", "def a():\n    return 1\n")
        git_commit(repo, "only")
        analysis, _layout, _result = self.build_city(repo)
        self.assertFalse(analysis.flags.tests)
        self.assertFalse(any(f.is_untested for f in analysis.files))


class HistoryTests(TempRepoCase):
    def test_second_build_reports_what_changed(self):
        repo = _layered_repo(self.scratch())
        out = os.path.join(self._tmp, "city")
        first, _layout, _result = self.build_city(repo, out_dir=out)
        self.assertIsNone(first.delta)
        self.assertFalse(first.flags.delta)
        self.assertTrue(os.path.exists(os.path.join(out, "summary.json")))

        body = "from core import model\n\n" + "".join(f"def f{i}():\n    return model.entity()\n\n" for i in range(30))
        _write(repo, "app/service.py", body)
        _write(repo, "app/new.py", "def fresh():\n    return 0\n")
        os.remove(os.path.join(repo, "app/jobs.py"))
        git_commit(repo, "grow", date="2024-02-01T10:00:00+00:00")

        second, _layout, result = self.build_city(repo, out_dir=out)
        delta = second.delta
        self.assertTrue(second.flags.delta)
        self.assertEqual(delta["added"], ["app/new.py"])
        self.assertEqual([p for p, _ in delta["removed"]], ["app/jobs.py"])
        self.assertIn("app/service.py", [p for p, _ in delta["grown"]])
        by_rel = {f.rel: f for f in second.files}
        self.assertEqual(by_rel["app/new.py"].delta, "added")
        self.assertEqual(by_rel["app/service.py"].delta, "grown")
        self.assertGreater(by_rel["app/service.py"].loc_delta, 20)
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        self.assertEqual(manifest["delta"]["removedCount"], 1)
        self.assertTrue(manifest["delta"]["added"])
        self.assertIn("files", manifest["delta"]["before"])

        # Rebuilding the same commit keeps comparing against the commit before.
        third, _layout, _result = self.build_city(repo, out_dir=out)
        self.assertEqual(third.delta["added"], ["app/new.py"])

    def test_encrypted_summaries_carry_no_paths(self):
        repo = _layered_repo(self.scratch())
        out = os.path.join(self._tmp, "locked")
        self.build_city(repo, out_dir=out, encrypt=True, passphrase="p")
        raw = read_bytes(os.path.join(out, "summary.json"))
        for probe in (b"service.py", b"core/", b"view.py"):
            self.assertNotIn(probe, raw)
        self.assertEqual(json.loads(raw)["keying"], "hmac")

    def test_compare_against_a_revision_and_gate(self):
        repo = _layered_repo(self.scratch())
        _write(repo, ".zion/rules.json", json.dumps({"layers": ["ui", "app", "core"]}))
        git_commit(repo, "layering rules", date="2024-01-15T10:00:00+00:00")
        _write(repo, "core/extra.py", "from ui import view\n\ndef bad():\n    return view.show()\n")
        git_commit(repo, "a new upward import", date="2024-02-01T10:00:00+00:00")
        env = dict(os.environ, ZION_CACHE=os.path.join(self._tmp, "cache"))
        run = lambda *args: subprocess.run(  # noqa: E731
            [sys.executable, os.path.join(ROOT, "zion.py"), *args], capture_output=True, text=True, env=env
        )
        ok = run("report", repo, "--compare", "HEAD~1", "--fail-on", "cycles")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("Since HEAD~1", ok.stdout)
        gated = run("report", repo, "--compare", "HEAD~1", "--fail-on", "new-violation,violations-up")
        self.assertEqual(gated.returncode, 1)
        self.assertIn("gate failed", gated.stderr)
        report = json.loads(run("report", repo, "--format", "json", "--fail-on", "new-cycle").stdout)
        self.assertEqual(report["gate"]["failures"], [])
        self.assertTrue(report["gate"]["unevaluated"])  # no baseline: said, not silently passed
        # The analyzed repository is never written to.
        status = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True)
        self.assertEqual(status.stdout.strip(), "")

    def test_build_compare_marks_the_city(self):
        repo = _layered_repo(self.scratch())
        _write(repo, "app/new.py", "def fresh():\n    return 0\n")
        git_commit(repo, "add", date="2024-02-01T10:00:00+00:00")
        out = os.path.join(self._tmp, "compared")
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "zion.py"), "build", repo, "-o", out, "--compare", "HEAD~1"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        manifest = read_json(os.path.join(out, "city.json"))
        self.assertEqual(len(manifest["delta"]["added"]), 1)
        legend = {e["id"]: e["enabled"] for e in manifest["legend"]}
        self.assertTrue(legend["delta"])


class ReportTests(TempRepoCase):
    def test_markdown_names_every_section(self):
        analysis, layout, _result = self.build_city(_layered_repo(self.scratch()), district_depth=1)
        report = build_report(analysis, layout)
        text = render_markdown(report)
        for heading in ("Hotspots", "Import cycles", "Layering violations", "Untested risky files", "## Folders"):
            self.assertIn(heading, text)
        self.assertIn("`core/rules.py` imports `app/service.py`", text)
        failures, skipped = evaluate_gates(report, ["violations", "cycles", "bogus"])
        self.assertEqual(len(failures), 1)
        self.assertTrue(any("bogus" in s for s in skipped))


if __name__ == "__main__":
    unittest.main()
