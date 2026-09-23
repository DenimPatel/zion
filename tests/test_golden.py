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

    def test_age_disabled_when_every_file_is_born_in_the_same_commit(self):
        # _city()'s later commits only edit alpha/main.py and README.md; every
        # file (including the ones never touched again) is born in commit 1.
        _repo, _analysis, _layout, result, manifest, _strings = self._city()
        self.assertFalse(manifest["flags"]["age"])
        self.assertTrue(any("birth date" in n for n in self._notes(result.out_dir)))
        legend = {entry["id"]: entry["enabled"] for entry in manifest["legend"]}
        self.assertFalse(legend["new_construction"])

    def test_age_enabled_and_new_file_flagged_when_born_later(self):
        import support

        repo = self.scratch()
        support.make_repo(repo, commit=False)
        support.git_commit(repo, "initial", date="2023-01-01T10:00:00+00:00")
        with open(os.path.join(repo, "alpha", "fresh.py"), "w", encoding="utf-8") as fh:
            fh.write("def fresh():\n    return 1\n")
        support.git_commit(repo, "add a new file", date="2023-12-20T10:00:00+00:00")

        analysis, layout, result = self.build_city(repo)
        manifest = load_manifest(result.out_dir)
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        self.assertTrue(manifest["flags"]["age"])

        by_path = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                by_path[resolve(strings, building["path"])] = building

        self.assertTrue(by_path["alpha/fresh.py"]["isNew"])
        self.assertEqual(by_path["alpha/fresh.py"]["era"], "new")
        self.assertFalse(by_path["alpha/main.py"]["isNew"])
        # main.py is tied for oldest with every other file from the initial
        # commit, so ties may land it in either of the two older tertiles --
        # but never in "new", the strictly-younger file's own bucket.
        self.assertNotEqual(by_path["alpha/main.py"]["era"], "new")

    def test_downtown_marks_the_most_imported_file(self):
        import support

        repo = self.scratch()
        os.makedirs(os.path.join(repo, "pkg"))
        with open(os.path.join(repo, "pkg", "__init__.py"), "w", encoding="utf-8") as fh:
            fh.write("")
        with open(os.path.join(repo, "pkg", "utils.py"), "w", encoding="utf-8") as fh:
            fh.write("def helper():\n    return 1\n")
        with open(os.path.join(repo, "pkg", "a.py"), "w", encoding="utf-8") as fh:
            fh.write("from pkg import utils\n\n\ndef use_a():\n    return utils.helper()\n")
        with open(os.path.join(repo, "pkg", "b.py"), "w", encoding="utf-8") as fh:
            fh.write("from pkg.utils import helper\n\n\ndef use_b():\n    return helper()\n")
        for name in "cdef":
            with open(os.path.join(repo, "pkg", f"{name}.py"), "w", encoding="utf-8") as fh:
                fh.write(f"def {name}_fn():\n    return '{name}'\n")

        support._run(["init", "-q"], repo)
        support._run(["config", "user.email", "test@example.com"], repo)
        support._run(["config", "user.name", "Test"], repo)
        support.git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")

        analysis, layout, result = self.build_city(repo)
        manifest = load_manifest(result.out_dir)
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        self.assertTrue(manifest["flags"]["centrality"])

        by_path = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                by_path[resolve(strings, building["path"])] = building

        self.assertEqual(by_path["pkg/utils.py"]["importInDegree"], 2)
        self.assertTrue(by_path["pkg/utils.py"]["downtown"])
        self.assertFalse(by_path["pkg/c.py"]["downtown"])
        self.assertFalse(by_path["pkg/a.py"]["downtown"])

    def test_sole_tenant_flags_a_single_owner_with_enough_commits(self):
        import support

        repo = self.scratch()
        support.make_repo(repo, commit=False)
        support.git_commit(repo, "initial", author="Ada Lovelace", date="2024-01-01T10:00:00+00:00")
        for i in range(2):
            with open(os.path.join(repo, "alpha", "main.py"), "a", encoding="utf-8") as fh:
                fh.write(f"\n# revision {i}\n")
            support.git_commit(repo, f"solo revision {i}", author="Ada Lovelace", date=f"2024-0{i + 2}-01T10:00:00+00:00")
        for i in range(2):
            with open(os.path.join(repo, "README.md"), "a", encoding="utf-8") as fh:
                fh.write(f"\nshared revision {i}\n")
            support.git_commit(
                repo, f"shared revision {i}",
                author="Ada Lovelace" if i % 2 else "Grace Hopper",
                date=f"2024-0{i + 4}-01T10:00:00+00:00",
            )

        analysis, layout, result = self.build_city(repo)
        manifest = load_manifest(result.out_dir)
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        self.assertTrue(manifest["flags"]["authorship"])

        by_path = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                by_path[resolve(strings, building["path"])] = building

        self.assertTrue(by_path["alpha/main.py"]["soleTenant"])

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
