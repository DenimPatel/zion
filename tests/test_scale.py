"""Scale tests: the synthetic generator and the adaptive district band.

These are deliberately small instances of the full-size benchmark. Running the
50,000-file case inside the unit suite would take minutes; the shape of the
problem (many directories, many authors, bulk first commit) is what matters here.

Streaming bounds are asserted in the browser instead -- see the `residentChunks`
and `residentBuildings` fields of `?bench=1`, and the `draw-calls` check in the
`?selftest=1` pass -- because the streaming logic lives in JavaScript and
duplicating it in Python would test a copy rather than the real thing.
"""

from __future__ import annotations

import os
import unittest

from support import TempRepoCase

from analyzer.gitmeta import read_git_index
from analyzer.layout import (
    MAX_DISTRICTS_LARGE,
    MAX_DISTRICTS_SMALL,
    district_band,
    district_counts,
    choose_depth,
)
from analyzer.metrics import analyze
from analyzer.walk import FileWalker
from bench.generate_repo import generate


class GeneratorTests(TempRepoCase):
    def test_generates_files_and_history(self):
        target = os.path.join(self._tmp, "synthetic")
        generate(target, files=120, directories=12, commits=5, quiet=True)

        walk = FileWalker(target).walk()
        self.assertEqual(walk.source, "git")
        # 120 generated files plus the folder READMEs.
        self.assertGreaterEqual(len(walk.files), 120)

        git = read_git_index(target, {e.rel for e in walk.files})
        self.assertEqual(git.commit_count, 5)
        self.assertEqual(git.author_count, 3)
        self.assertGreaterEqual(git.active_dates, 3)
        # The first commit carries everything, so it must be excluded from
        # coupling rather than becoming a complete graph.
        self.assertGreaterEqual(git.bulk_commits, 1)

    def test_all_legend_families_are_enabled(self):
        target = os.path.join(self._tmp, "synthetic")
        generate(target, files=120, directories=12, commits=5, quiet=True)
        walk = FileWalker(target).walk()
        git = read_git_index(target, {e.rel for e in walk.files})
        analysis = analyze(target, walk.files, git)

        self.assertTrue(analysis.flags.authorship)
        self.assertTrue(analysis.flags.recency)
        self.assertTrue(analysis.flags.churn)
        self.assertTrue(analysis.flags.coupling)

    def test_is_deterministic(self):
        first = os.path.join(self._tmp, "a")
        second = os.path.join(self._tmp, "b")
        generate(first, files=60, directories=6, commits=2, quiet=True)
        generate(second, files=60, directories=6, commits=2, quiet=True)
        names_a = sorted(FileWalker(first).walk().files[i].rel for i in range(10))
        names_b = sorted(FileWalker(second).walk().files[i].rel for i in range(10))
        self.assertEqual(names_a, names_b)


class DistrictBandTests(unittest.TestCase):
    def test_band_widens_for_large_repositories(self):
        self.assertEqual(district_band(100)[1], MAX_DISTRICTS_SMALL)
        self.assertEqual(district_band(50_000)[1], MAX_DISTRICTS_LARGE)

    def test_large_repo_gets_more_than_a_handful_of_districts(self):
        # 8 top-level folders but 320 plausible second-level ones: a fixed cap of
        # 64 would describe a 50,000-file repo with eight enormous districts.
        import types

        rels = []
        for top in range(8):
            for middle in range(40):
                for leaf in range(20):
                    rels.append(f"t{top}/m{middle}/l{leaf}/f{leaf}.py")
        files = [types.SimpleNamespace(rel=r) for r in rels]
        counts = district_counts(files, 3)
        chosen = choose_depth(files)
        low, high = district_band(len(files))
        self.assertLessEqual(counts[chosen], high)
        self.assertEqual(counts[chosen], 320)
        self.assertEqual(chosen, 2)


if __name__ == "__main__":
    unittest.main()
