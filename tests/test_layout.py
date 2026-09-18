"""Layout tests: district depth and the street-generating treemap."""

from __future__ import annotations

import types
import unittest

from support import TempRepoCase, make_repo

from analyzer.gitmeta import read_git_index
from analyzer.layout import (
    ROOT_DISTRICT,
    build_layout,
    choose_depth,
    district_counts,
    district_key,
)
from analyzer.metrics import analyze
from analyzer.walk import FileWalker



class DistrictKeyTests(unittest.TestCase):
    def test_directory_is_truncated_not_the_whole_path(self):
        # At depth 2 a file inside alpha/ belongs to `alpha`, not to a district
        # named after itself and not to the root district.
        self.assertEqual(district_key("alpha/main.py", 2), "alpha")
        self.assertEqual(district_key("alpha/main.py", 1), "alpha")
        self.assertEqual(district_key("beta/data/counts.csv", 2), "beta/data")
        self.assertEqual(district_key("beta/data/counts.csv", 1), "beta")
        self.assertEqual(district_key("README.md", 2), ROOT_DISTRICT)
        self.assertEqual(district_key("delta gamma/thing.js", 1), "delta gamma")


class DepthChoiceTests(unittest.TestCase):
    def _files(self, rels):
        return [types.SimpleNamespace(rel=r) for r in rels]

    def test_picks_most_structure_inside_the_band(self):
        # depth 1 -> 11 districts, depth 2 -> 30, depth 3 -> 298 (too many).
        rels = []
        for i in range(11):
            rels.append(f"top{i}/a/b/c{ i }.py")
        for i in range(30):
            rels.append(f"top{i % 11}/mid{i}/leaf/f{i}.py")
        for i in range(300):
            rels.append(f"top{i % 11}/mid{i % 30}/leaf{i}/deep/f{i}.py")
        counts = district_counts(self._files(rels), 4)
        self.assertIn(1, counts)
        chosen = choose_depth(self._files(rels))
        self.assertLessEqual(counts[chosen], 64)
        self.assertGreaterEqual(counts[chosen], 4)

    def test_ties_prefer_the_shallowest_depth(self):
        # Three top-level folders stay three folders at every depth.  A repo like
        # this should be described at depth 1, not depth 8.
        rels = ["a/x.py", "b/y.py", "c/z.py", "README.md"]
        self.assertEqual(choose_depth(self._files(rels)), 1)

    def test_falls_back_when_nothing_is_in_the_band(self):
        rels = ["a/x.py"]
        chosen = choose_depth(self._files(rels))
        self.assertGreaterEqual(chosen, 1)


class TreemapTests(TempRepoCase):
    def test_every_building_sits_inside_its_district(self):
        repo = make_repo(self.scratch())
        walk = FileWalker(repo).walk()
        git = read_git_index(repo, {e.rel for e in walk.files})
        analysis = analyze(repo, walk.files, git)
        layout = build_layout(analysis)

        self.assertGreater(len(layout.districts), 0)
        self.assertGreater(layout.bounds.w, 0)
        self.assertGreater(layout.bounds.h, 0)

        for district in layout.districts:
            for building in district.buildings:
                self.assertGreaterEqual(building.x, district.rect.x - 1e-6)
                self.assertGreaterEqual(building.y, district.rect.y - 1e-6)
                self.assertLessEqual(
                    building.x + building.width, district.rect.x + district.rect.w + 1e-6
                )
                self.assertLessEqual(
                    building.y + building.depth, district.rect.y + district.rect.h + 1e-6
                )
                self.assertGreater(building.height, 0)
                self.assertIn(building.rel, {f.rel for f in analysis.files})

        for district in layout.districts:
            self.assertEqual(
                sum(1 for b in district.buildings), district.building_count
            )

    def test_streets_are_generated_between_districts(self):
        repo = make_repo(self.scratch())
        analysis, layout = self._layout(repo)
        if len(layout.districts) > 1:
            self.assertGreater(len(layout.streets), 0)
            for street in layout.streets:
                self.assertGreater(street.w, 0)
                self.assertGreater(street.h, 0)

    def _layout(self, repo):
        walk = FileWalker(repo).walk()
        git = read_git_index(repo, {e.rel for e in walk.files})
        analysis = analyze(repo, walk.files, git)
        return analysis, build_layout(analysis)


if __name__ == "__main__":
    unittest.main()
