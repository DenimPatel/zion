"""Nested folder layout: regions on plinths, road classes by folder distance."""

from __future__ import annotations

import os
import unittest

from support import TempRepoCase, git_commit

from analyzer.gitmeta import read_git_index
from analyzer.layout import (
    ROAD_ALLEY,
    ROAD_HIGHWAY,
    ROOT_DISTRICT,
    Rect,
    build_layout,
    district_key,
)
from analyzer.metrics import analyze
from analyzer.walk import FileWalker

# Three levels of nesting under two top-level folders, plus a single-child
# chain (lib/only/deeper) that must collapse rather than cost a plinth.
TREE = {
    "README.md": "# nested\n",
    "app/core/model/user.py": "def a():\n    return 1\n" * 12,
    "app/core/model/order.py": "def b():\n    return 2\n" * 10,
    "app/core/view/page.py": "def c():\n    return 3\n" * 8,
    "app/core/view/form.py": "def d():\n    return 4\n" * 8,
    "app/api/routes.py": "def e():\n    return 5\n" * 14,
    "app/api/auth.py": "def f():\n    return 6\n" * 6,
    "app/main.py": "def g():\n    return 7\n" * 4,
    "lib/only/deeper/x.py": "def h():\n    return 8\n" * 9,
    "lib/only/deeper/y.py": "def i():\n    return 9\n" * 9,
    "docs/guide.md": "# Guide\n\ntext\n",
    "docs/api.md": "# API\n\ntext\n",
}


def _inside(inner: Rect, outer: Rect, slack: float = 1e-6) -> bool:
    return (
        inner.x >= outer.x - slack
        and inner.y >= outer.y - slack
        and inner.x + inner.w <= outer.x + outer.w + slack
        and inner.y + inner.h <= outer.y + outer.h + slack
    )


def _overlap_area(a, b) -> float:
    w = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
    h = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    return max(0.0, w) * max(0.0, h)


class NestedLayoutTests(TempRepoCase):
    def _repo(self) -> str:
        repo = self.scratch()
        for rel, body in TREE.items():
            path = os.path.join(repo, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        import subprocess

        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        git_commit(repo, "initial")
        return repo

    def _layout(self, depth: int = 3):
        repo = self._repo()
        walk = FileWalker(repo).walk()
        git = read_git_index(repo, {e.rel for e in walk.files})
        analysis = analyze(repo, walk.files, git)
        return analysis, build_layout(analysis, depth)

    def test_leaf_districts_are_the_same_folders_as_a_flat_layout(self):
        analysis, layout = self._layout(3)
        expected = {district_key(f.rel, 3) for f in analysis.files}
        self.assertEqual({d.key for d in layout.districts}, expected)
        for district in layout.districts:
            members = {f.rel for f in analysis.files if district_key(f.rel, 3) == district.key}
            self.assertEqual({b.rel for b in district.buildings}, members)

    def test_regions_nest_and_every_district_traces_to_the_top(self):
        _analysis, layout = self._layout(3)
        regions = {r.key: r for r in layout.regions}
        self.assertIn("app", regions)
        self.assertIn("app/core", regions)
        self.assertEqual(regions["app/core"].parent, "app")
        self.assertEqual(regions["app"].level, 1)
        self.assertEqual(regions["app/core"].level, 2)
        # A folder with a single child is a pass-through, not a plinth.
        self.assertNotIn("lib", regions)
        self.assertNotIn("lib/only", regions)

        for region in layout.regions:
            if region.parent:
                parent = regions[region.parent]
                self.assertEqual(region.level, parent.level + 1)
                self.assertTrue(_inside(region.rect, parent.rect), region.key)

        for district in layout.districts:
            key, hops = district.region, 0
            if key:
                self.assertTrue(_inside(district.rect, regions[key].rect), district.key)
            while key:
                key = regions[key].parent
                hops += 1
            self.assertEqual(hops, district.level, district.key)

        by_key = {d.key: d for d in layout.districts}
        self.assertEqual(by_key["app/core/model"].region, "app/core")
        self.assertEqual(by_key["app/core/model"].level, 2)
        self.assertEqual(by_key[ROOT_DISTRICT].level, 0)

    def test_roads_narrow_with_folder_depth(self):
        _analysis, layout = self._layout(3)
        classes = {s.cls for s in layout.streets}
        self.assertIn(ROAD_HIGHWAY, classes)
        self.assertTrue(classes <= set(range(ROAD_ALLEY + 1)))
        widths = layout.road_widths
        self.assertTrue(all(widths[i] > widths[i + 1] for i in range(len(widths) - 1)))
        # Roads inside a region are the class of that region's level.
        regions = {r.key: r for r in layout.regions}
        core = regions["app/core"]
        inner = [s for s in layout.streets if _inside(s, core.rect)]
        self.assertTrue(inner, "app/core split into model/view needs a road")
        self.assertTrue(all(s.cls == 2 for s in inner))

    def test_no_building_stands_on_a_road(self):
        _analysis, layout = self._layout(3)
        for district in layout.districts:
            for building in district.buildings:
                plot = Rect(building.x, building.y, building.width, building.depth)
                for street in layout.streets:
                    self.assertLess(
                        _overlap_area(plot, street), 1e-6, f"{building.rel} is built on a road"
                    )

    def test_districts_do_not_overlap(self):
        _analysis, layout = self._layout(3)
        rects = [d.rect for d in layout.districts]
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                self.assertLess(_overlap_area(rects[i], rects[j]), 1e-6)


if __name__ == "__main__":
    unittest.main()
