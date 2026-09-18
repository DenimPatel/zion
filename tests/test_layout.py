"""Layout tests: district depth and the street-generating treemap."""

from __future__ import annotations

import types
import unittest

from support import TempRepoCase, make_repo

from analyzer.gitmeta import read_git_index
from analyzer.layout import (
    CITY_HALL_PLAZA_MARGIN,
    CITY_HALL_PLAZA_RADIUS,
    ROOT_DISTRICT,
    Rect,
    _city_hall_scale,
    _frame_around,
    build_layout,
    choose_depth,
    district_counts,
    district_key,
)
from analyzer.metrics import analyze
from analyzer.walk import FileWalker


def _overlaps(a, b) -> bool:
    """Do two axis-aligned rectangles share ground?"""
    return not (
        a.x + a.w <= b.x
        or b.x + b.w <= a.x
        or a.y + a.h <= b.y
        or b.y + b.h <= a.y
    )



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

    def test_no_building_stands_on_the_city_hall_plaza(self):
        """The landmark owns its ground: nothing is built inside the reserve."""
        repo = make_repo(self.scratch())
        analysis, layout = self._layout(repo)

        self.assertIsNotNone(layout.plaza)
        self.assertGreater(layout.hall_scale, 0)
        plaza = layout.plaza

        # The reserve is inside the plan, not hanging off it.
        self.assertGreaterEqual(plaza.x, layout.bounds.x)
        self.assertGreaterEqual(plaza.y, layout.bounds.y)
        self.assertLessEqual(plaza.x + plaza.w, layout.bounds.x + layout.bounds.w + 1e-6)
        self.assertLessEqual(plaza.y + plaza.h, layout.bounds.y + layout.bounds.h + 1e-6)

        hall = layout.city_hall()
        self.assertIsNotNone(hall)
        fx, fz, fw, fh = hall["footprint"]
        self.assertGreaterEqual(fx, plaza.x)
        self.assertGreaterEqual(fz, plaza.y)
        self.assertLessEqual(fx + fw, plaza.x + plaza.w + 1e-6)
        self.assertLessEqual(fz + fh, plaza.y + plaza.h + 1e-6)

        # The plaza a district may reach into is a plaza, not a plot.
        for district in layout.districts:
            self.assertFalse(
                _overlaps(district.rect, plaza),
                f"district {district.key} covers the City Hall plaza",
            )
            for building in district.buildings:
                self.assertFalse(
                    _overlaps(
                        Rect(building.x, building.y, building.width, building.depth),
                        plaza,
                    ),
                    f"{building.rel} is built on the City Hall plaza",
                )

    def test_a_small_plan_still_leaves_a_usable_frame(self):
        """A tiny city must not be all forecourt: the frame survives the reserve.

        The tallest building drives the hall's size, which is exactly how a small
        repository would end up with nothing but plaza. The scale is capped by the
        plan, so every plan size keeps ground for districts on all four sides.
        """
        for side in (60.0, 90.0, 159.0, 700.0, 3200.0):
            scale = _city_hall_scale(side, 400.0)
            half = CITY_HALL_PLAZA_RADIUS * scale + CITY_HALL_PLAZA_MARGIN
            self.assertLess(half, side / 2.0, f"plaza swallowed a {side} m plan")
            plaza = Rect(side / 2.0 - half, side / 2.0 - half, 2 * half, 2 * half)
            bands = _frame_around(Rect(0.0, 0.0, side, side), plaza)
            self.assertEqual(len(bands), 4, f"a {side} m plan lost a band")
            for band in bands:
                self.assertGreater(band.w, 1.0)
                self.assertGreater(band.h, 1.0)

    def _layout(self, repo):
        walk = FileWalker(repo).walk()
        git = read_git_index(repo, {e.rel for e in walk.files})
        analysis = analyze(repo, walk.files, git)
        return analysis, build_layout(analysis)


if __name__ == "__main__":
    unittest.main()
