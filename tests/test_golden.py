"""End-to-end golden tests against the tiny fixture repository.

Every expectation here is derivable by hand from the committed template, so the
test fails loudly if a metric silently changes meaning.
"""

from __future__ import annotations

import json
import os
import unittest

from support import (
    TempRepoCase,
    load_manifest,
    make_repo,
    read_bytes,
    read_json,
    read_string_table,
    resolve,
)

from analyzer.walk import FileWalker


class GoldenCityTests(TempRepoCase):
    def _city(self, **kwargs):
        repo = make_repo(
            self.scratch(),
            authors=kwargs.pop("authors", ("Ada Lovelace", "Grace Hopper")),
            dates=kwargs.pop(
                "dates",
                (
                    "2024-01-01T10:00:00+00:00",
                    "2024-02-01T10:00:00+00:00",
                    "2024-03-01T10:00:00+00:00",
                ),
            ),
        )
        analysis, layout, result = self.build_city(repo, **kwargs)
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        manifest = load_manifest(result.out_dir)
        return repo, analysis, layout, result, manifest, strings

    def test_shape_is_known(self):
        _repo, analysis, layout, _result, manifest, strings = self._city()

        names = sorted(resolve(strings, d["key"]) for d in manifest["districts"])
        self.assertEqual(names, ["(root)", "alpha", "beta", "delta gamma"])
        self.assertEqual(manifest["meta"]["districtDepth"], 1,
                         "depth 2 would split beta into single-building districts")
        self.assertEqual(manifest["meta"]["buildingCount"], len(analysis.files))

    def test_gitignored_files_are_not_buildings(self):
        _repo, _analysis, _layout, _result, manifest, strings = self._city()
        paths = set()
        for district in manifest["districts"]:
            with open(
                os.path.join(self._tmp, "city", district["chunk"]), encoding="utf-8"
            ) as fh:
                for building in json.load(fh)["buildings"]:
                    paths.add(resolve(strings, building["path"]))
        self.assertNotIn("debug.log", paths)
        self.assertNotIn(".DS_Store", paths)
        self.assertFalse(any(p.startswith("build/") for p in paths))
        self.assertGreaterEqual(manifest["meta"]["noiseExcluded"], 4)

    def test_town_hall_only_where_a_readme_lives(self):
        _repo, _analysis, _layout, _result, manifest, strings = self._city()
        by_name = {resolve(strings, d["key"]): d for d in manifest["districts"]}
        self.assertTrue(by_name["alpha"]["hasReadme"])
        self.assertTrue(by_name["(root)"]["hasReadme"])
        self.assertFalse(by_name["beta"]["hasReadme"])
        self.assertFalse(by_name["delta gamma"]["hasReadme"])
        self.assertEqual(manifest["stats"]["districtsWithReadme"], 2)

    def test_archetypes_follow_the_legend(self):
        _repo, _analysis, layout, result, _manifest, strings = self._city()
        archetypes = {}
        for district in _manifest["districts"]:
            with open(
                os.path.join(result.out_dir, district["chunk"]), encoding="utf-8"
            ) as fh:
                for building in json.load(fh)["buildings"]:
                    archetypes[resolve(strings, building["path"])] = building["archetype"]

        self.assertEqual(archetypes["beta/tests/test_pipeline.py"], "park")
        self.assertEqual(archetypes["beta/data/counts.csv"], "silo")
        self.assertEqual(archetypes["huge.json"], "silo")
        self.assertEqual(archetypes["alpha/README.md"], "town_hall")
        self.assertIn(archetypes["beta/pipeline.py"], {"tower", "slab", "warehouse"})

    def test_data_silo_height_comes_from_rows_not_bytes(self):
        _repo, _analysis, _layout, result, manifest, strings = self._city()
        for district in manifest["districts"]:
            with open(
                os.path.join(result.out_dir, district["chunk"]), encoding="utf-8"
            ) as fh:
                for building in json.load(fh)["buildings"]:
                    path = resolve(strings, building["path"])
                    if path == "huge.json":
                        self.assertEqual(building["rows"], 50)
                        # 494 bytes, 50 rows, and at most one physical line.
                        self.assertLessEqual(building["physicalLines"], 1)
                    if path == "beta/data/counts.csv":
                        self.assertEqual(building["rows"], 4)

    def test_notebook_interior_is_cell_source_not_the_wrapper(self):
        _repo, _analysis, _layout, result, manifest, strings = self._city()
        building = self._find(result.out_dir, manifest, strings, "beta/notebook.ipynb")
        detail = read_json(os.path.join(result.out_dir, building["detail"]))
        source = read_bytes(os.path.join(result.out_dir, building["source"]))

        self.assertGreater(detail["srcBytes"], 0)
        self.assertIn(b"math.pi", source)
        # The base64 PNG output must not be anywhere in the interior.
        self.assertNotIn(b"iVBORw0KGgo", source)
        self.assertGreater(len(detail["floors"]), 0)

    def test_floor_slices_are_exact_source(self):
        _repo, _analysis, _layout, result, manifest, strings = self._city()
        building = self._find(result.out_dir, manifest, strings, "alpha/main.py")
        detail = read_json(os.path.join(result.out_dir, building["detail"]))
        source = read_bytes(os.path.join(result.out_dir, building["source"]))

        slices = {}
        for floor in detail["floors"]:
            name = resolve(strings, floor["name"])
            slices[name] = source[floor["srcOffset"] : floor["srcOffset"] + floor["srcLength"]]

        self.assertTrue(slices["documented"].startswith(b"def documented("))
        self.assertTrue(slices["Alpha"].startswith(b"class Alpha:"))
        self.assertTrue(slices["bare"].startswith(b"    def bare("))
        self.assertIn(b"return a + b", slices["documented"])

    def test_flags_are_computed_from_the_legend_rules(self):
        _repo, _analysis, _layout, _result, manifest, _strings = self._city()
        flags = manifest["flags"]
        self.assertTrue(flags["authorship"], "two authors should enable mayors")
        self.assertTrue(flags["recency"], "three commit dates should enable weathering")
        self.assertTrue(flags["coupling"], "two small overlapping commits should enable bridges")
        self.assertFalse(flags["churn"], "three commits is below the churn threshold")

    def test_configuration_disables_degenerate_legend_entries(self):
        repo = make_repo(self.scratch("single"), authors=("Ada Lovelace",))
        from support import DEMO_SMALL  # noqa: F401  (path constants live in support)

        analysis, layout, result = self.build_city(repo)
        manifest = load_manifest(result.out_dir)
        flags = manifest["flags"]
        self.assertFalse(flags["authorship"])
        self.assertFalse(flags["recency"])
        self.assertTrue(any("Single author" in n for n in self._notes(result.out_dir)))

        legend = {entry["id"]: entry["enabled"] for entry in manifest["legend"]}
        self.assertFalse(legend["author_tint"])
        self.assertFalse(legend["weathering"])
        # The drop-out is announced rather than silently drawn.
        self.assertTrue(legend["height"])

    def test_include_noise_adds_ruins(self):
        repo = make_repo(self.scratch())
        _analysis, _layout, clean = self.build_city(repo, out_dir=os.path.join(self._tmp, "clean"))
        _a2, _l2, noisy = self.build_city(
            repo, out_dir=os.path.join(self._tmp, "noisy"), include_noise=True
        )
        clean_manifest = load_manifest(clean.out_dir)
        noisy_manifest = load_manifest(noisy.out_dir)
        self.assertGreater(
            noisy_manifest["meta"]["buildingCount"], clean_manifest["meta"]["buildingCount"]
        )
        strings = read_string_table(os.path.join(noisy.out_dir, "strings.bin"))
        ruins = 0
        for district in noisy_manifest["districts"]:
            with open(
                os.path.join(noisy.out_dir, district["chunk"]), encoding="utf-8"
            ) as fh:
                for building in json.load(fh)["buildings"]:
                    if building["isRuin"]:
                        ruins += 1
        self.assertGreater(ruins, 0)

    # -- helpers -------------------------------------------------------
    def _find(self, out_dir, manifest, strings, path):
        for district in manifest["districts"]:
            with open(os.path.join(out_dir, district["chunk"]), encoding="utf-8") as fh:
                for building in json.load(fh)["buildings"]:
                    if resolve(strings, building["path"]) == path:
                        return building
        raise AssertionError(f"{path} not found in city")

    def _notes(self, out_dir):
        manifest = load_manifest(out_dir)
        strings = read_string_table(os.path.join(out_dir, "strings.bin"))
        return [resolve(strings, i) for i in manifest["stats"]["notes"]]


if __name__ == "__main__":
    unittest.main()
