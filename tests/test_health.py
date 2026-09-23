"""Architect's signals: people, hotspots, oversized files, orphans, cycles."""

from __future__ import annotations

import os
import subprocess
import unittest

from support import TempRepoCase, git_commit, read_json

from analyzer.health import bus_factor, is_vendored, strongly_connected


class PureFunctionTests(unittest.TestCase):
    def test_bus_factor_counts_authors_to_half_the_lines(self):
        self.assertEqual(bus_factor({"a": 90, "b": 10}), 1)
        self.assertEqual(bus_factor({"a": 40, "b": 35, "c": 25}), 2)
        self.assertEqual(bus_factor({"a": 25, "b": 25, "c": 25, "d": 25}), 2)
        self.assertEqual(bus_factor({}), 0)

    def test_vendored_code_is_recognised(self):
        self.assertTrue(is_vendored("vendor/three.module.js"))
        self.assertTrue(is_vendored("web/third_party/lib/x.js"))
        self.assertTrue(is_vendored("static/app.min.js"))
        self.assertFalse(is_vendored("src/vendor.py"))
        self.assertFalse(is_vendored("analyzer/emit.py"))

    def test_strongly_connected_finds_only_real_cycles(self):
        edges = {"a": {"b"}, "b": {"c"}, "c": {"a"}, "d": {"a"}, "e": {"f"}}
        self.assertEqual(strongly_connected(edges), [["a", "b", "c"]])
        self.assertEqual(strongly_connected({"x": {"y"}}), [])

    def test_strongly_connected_survives_a_long_chain(self):
        # Iterative, so a 5,000-deep import chain does not hit the recursion limit.
        edges = {f"n{i}": {f"n{i + 1}"} for i in range(5000)}
        edges["n5000"] = {"n0"}
        cycles = strongly_connected(edges)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(len(cycles[0]), 5001)


def _write(repo: str, rel: str, body: str) -> None:
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path) or repo, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)


class RepoSignalTests(TempRepoCase):
    """A small history where every signal has exactly one right answer."""

    def _repo(self) -> str:
        repo = self.scratch()
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        # 2023: Old Owner writes the whole package, including a cycle and a
        # module nothing imports; then leaves.
        _write(repo, "pkg/__init__.py", "")
        _write(repo, "pkg/a.py", "from pkg import b\n\ndef fa():\n    return b.fb()\n")
        _write(repo, "pkg/b.py", "from pkg import a\n\ndef fb():\n    return 1\n")
        _write(repo, "pkg/unused.py", "def lonely():\n    return 0\n")
        big = "".join(f"def f{i}(x):\n    if x:\n        return {i}\n    return x\n\n" for i in range(160))
        _write(repo, "pkg/big.py", big)
        for i in range(20):
            _write(repo, f"pkg/small{i}.py", f"from pkg import big\n\ndef s{i}():\n    return {i}\n")
        _write(repo, "app.py", "import pkg.a\n\ndef main():\n    return pkg.a.fa()\n\nif __name__ == '__main__':\n    main()\n")
        git_commit(repo, "initial", author="Old Owner", email="old@example.com", date="2023-01-01T10:00:00+00:00")
        # 2024: New Dev edits big.py repeatedly; Old Owner never returns.
        for n in range(6):
            with open(os.path.join(repo, "pkg/big.py"), "a", encoding="utf-8") as fh:
                fh.write(f"\ndef extra{n}():\n    return {n}\n")
            _write(repo, "pkg/small0.py", f"from pkg import big\n\ndef s0():\n    return {n}\n")
            git_commit(
                repo, f"edit {n}", author="New Dev", email="new@example.com",
                date=f"2024-06-0{n + 1}T10:00:00+00:00",
            )
        return repo

    def test_people_fields(self):
        analysis, _layout, _result = self.build_city(self._repo())
        by_rel = {f.rel: f for f in analysis.files}
        big = by_rel["pkg/big.py"]
        self.assertEqual(big.first_author, "Old Owner")
        self.assertEqual(big.last_author, "New Dev")
        self.assertEqual(big.author_count, 2)
        b = by_rel["pkg/b.py"]
        self.assertEqual(b.bus_factor, 1)
        self.assertTrue(b.owner_inactive)
        self.assertTrue(b.knowledge_risk)
        self.assertTrue(analysis.flags.knowledge)

    def test_cycle_orphan_and_oversized(self):
        analysis, _layout, _result = self.build_city(self._repo())
        by_rel = {f.rel: f for f in analysis.files}
        self.assertTrue(analysis.flags.imports)
        self.assertEqual(by_rel["pkg/a.py"].cycle_id, by_rel["pkg/b.py"].cycle_id)
        self.assertEqual(by_rel["pkg/a.py"].cycle_size, 2)
        self.assertEqual(by_rel["pkg/big.py"].cycle_id, 0)
        # Nothing imports unused.py and it has sat still for over a year.
        self.assertTrue(by_rel["pkg/unused.py"].is_orphan)
        # A module that only imports, and that nothing imports, is a candidate too.
        self.assertTrue(by_rel["pkg/small3.py"].is_orphan)
        # Entry points, recently edited files and imported modules are not orphans.
        self.assertFalse(by_rel["pkg/small0.py"].is_orphan)
        self.assertFalse(by_rel["app.py"].is_orphan)
        self.assertFalse(by_rel["pkg/big.py"].is_orphan)
        self.assertFalse(by_rel["pkg/__init__.py"].is_orphan)
        # big.py is the only file in the top 5% and past 400 lines.
        oversized = [f.rel for f in analysis.files if f.is_oversized]
        self.assertEqual(oversized, ["pkg/big.py"])
        self.assertIsNotNone(by_rel["pkg/big.py"].longest_floor)
        self.assertGreaterEqual(by_rel["pkg/big.py"].max_complexity, 1)

    def test_hotspot_is_big_and_busy(self):
        analysis, _layout, _result = self.build_city(self._repo())
        hot = [f for f in analysis.files if f.is_hotspot]
        self.assertTrue(analysis.flags.hotspots)
        self.assertEqual(hot[0].rel, "pkg/big.py")
        self.assertEqual(hot[0].hotspot_rank, 1)

    def test_manifest_carries_signals_and_review(self):
        _analysis, _layout, result = self.build_city(self._repo())
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        legend = {e["id"]: e for e in manifest["legend"]}
        for key in ("hotspots", "oversized", "orphans", "cycles", "knowledge", "roads", "regions"):
            self.assertIn(key, legend)
            self.assertTrue(legend[key]["description"])
            self.assertTrue(legend[key]["group"])
        self.assertTrue(legend["cycles"]["enabled"])
        review = manifest["review"]
        self.assertEqual(len(review["cycles"]), 1)
        self.assertEqual(len(review["cycles"][0]), 2)
        self.assertEqual(review["totals"]["oversized"], 1)
        for street in manifest["streets"]:
            self.assertEqual(len(street), 5)
            self.assertIn(street[4], (0, 1, 2, 3))

        chunk_buildings = []
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            chunk_buildings.extend(chunk["buildings"])
        ids = {b["id"] for b in chunk_buildings}
        self.assertTrue(set(review["oversized"]) <= ids)
        sample = chunk_buildings[0]
        for field in ("firstAuthor", "lastAuthor", "authorCount", "busFactor", "isHotspot", "sizePct",
                      "oversized", "longestFloor", "maxComplexity", "orphan", "cycle", "knowledgeRisk"):
            self.assertIn(field, sample)


class DegenerateRepoTests(TempRepoCase):
    def test_single_commit_repo_raises_no_history_signals(self):
        repo = self.scratch()
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        _write(repo, "a.py", "def a():\n    return 1\n")
        _write(repo, "b.py", "def b():\n    return 1\n")
        git_commit(repo, "only")
        analysis, _layout, result = self.build_city(repo)
        self.assertFalse(analysis.flags.hotspots)
        self.assertFalse(analysis.flags.knowledge)
        self.assertFalse(any(f.is_hotspot or f.knowledge_risk or f.is_orphan for f in analysis.files))
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        legend = {e["id"]: e["enabled"] for e in manifest["legend"]}
        self.assertFalse(legend["hotspots"])
        self.assertFalse(legend["knowledge"])


if __name__ == "__main__":
    unittest.main()
