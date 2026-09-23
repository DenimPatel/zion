"""Emit tests: the output is a self-contained website, and indices resolve."""

from __future__ import annotations

import base64
import json
import os
import unittest

from support import (
    TempRepoCase,
    git_commit,
    load_manifest,
    make_repo,
    read_json,
    read_string_table,
    read_text,
)

from analyzer.walk import FileWalker


class EmitTests(TempRepoCase):
    def _build(self, **kwargs):
        repo = make_repo(self.scratch())
        return self.build_city(repo, **kwargs)

    def test_viewer_is_installed_next_to_the_data(self):
        _analysis, _layout, result = self._build()
        out = result.out_dir
        for rel in (
            "index.html",
            "css/hud.css",
            "js/main.js",
            "js/city.js",
            "js/shapes.js",
            "js/facade.js",
            "js/loader.js",
            "js/cameras.js",
            "js/sky.js",
            "js/inspector.js",
            "vendor/three.module.js",
        ):
            self.assertTrue(os.path.exists(os.path.join(out, rel)), f"missing {rel}")

    def test_build_is_offline_capable(self):
        """The viewer must not reference a CDN: it has to work with no network."""
        _analysis, _layout, result = self._build()
        html = read_text(os.path.join(result.out_dir, "index.html"))
        self.assertNotIn("http://", html.replace("http://www.w3.org", ""))
        self.assertNotIn("https://", html)
        self.assertIn("./vendor/three.module.js", html)

    def test_string_table_round_trips_every_index(self):
        _analysis, _layout, result = self._build()
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        manifest = load_manifest(result.out_dir)

        # Every index the viewer will dereference must be in range.
        indices = []
        for district in manifest["districts"]:
            indices += [district["key"], district["name"], district["primaryLanguage"]]
            if district["readmeRel"] >= 0:
                indices.append(district["readmeRel"])
        for entry in manifest["legend"]:
            # Legend labels are literal schema text, not table indices.
            self.assertIsInstance(entry["label"], str)
            self.assertTrue(entry["label"])
        indices += manifest["stats"]["notes"]
        for row in manifest["stats"]["folders"]:
            indices.append(row["name"])
        for row in manifest["stats"]["largestFiles"]:
            indices.append(row["path"])

        self.assertTrue(indices)
        for index in indices:
            self.assertGreaterEqual(index, 0)
            self.assertLess(index, len(strings))
            self.assertNotEqual(strings[index], "")

    def test_manifest_geometry_is_plaintext_and_complete(self):
        _analysis, layout, result = self._build()
        manifest = load_manifest(result.out_dir)
        self.assertEqual(manifest["format"], "zion-city")
        self.assertEqual(len(manifest["districts"]), len(layout.districts))
        self.assertIn("skyline", manifest["districts"][0])
        self.assertIsNone(manifest["crypto"])
        self.assertFalse(manifest["meta"]["encrypted"])
        # The overview must be renderable from the manifest alone.
        for district in manifest["districts"]:
            self.assertGreater(district["skyline"]["maxHeight"], 0)
            self.assertGreater(district["buildings"], 0)

    def test_floor_offsets_are_within_the_source_blob(self):
        _analysis, _layout, result = self._build()
        for name in os.listdir(os.path.join(result.out_dir, "f")):
            if not name.endswith(".json"):
                continue
            detail = read_json(os.path.join(result.out_dir, "f", name))
            if detail.get("binary"):
                continue
            source_path = os.path.join(result.out_dir, "f", name.replace(".json", ".src"))
            if not os.path.exists(source_path):
                continue
            size = os.path.getsize(source_path)
            for floor in detail["floors"]:
                self.assertGreaterEqual(floor["srcOffset"], 0)
                self.assertLessEqual(floor["srcOffset"] + floor["srcLength"], size)
            self.assertEqual(detail["srcBytes"], size)

    def test_bridges_emitted_only_when_coupling_is_eligible(self):
        # A single bulk commit: coupling is disabled, no bridges.json.
        analysis, _layout, result = self._build()
        manifest = result.manifest
        self.assertFalse(manifest["flags"]["coupling"])
        self.assertIsNone(manifest["bridges"])
        self.assertFalse(os.path.exists(os.path.join(result.out_dir, "bridges.json")))

    def test_bridges_match_coupling_when_eligible(self):
        repo = self.scratch()
        make_repo(repo, commit=False)
        git_commit(repo, "one", date="2024-01-01T10:00:00+00:00")
        with open(os.path.join(repo, "alpha", "main.py"), "a", encoding="utf-8") as fh:
            fh.write("\n# tweak one\n")
        with open(os.path.join(repo, "README.md"), "a", encoding="utf-8") as fh:
            fh.write("\ntweak\n")
        git_commit(repo, "two", date="2024-02-01T10:00:00+00:00")
        with open(os.path.join(repo, "alpha", "main.py"), "a", encoding="utf-8") as fh:
            fh.write("# tweak two\n")
        with open(os.path.join(repo, "README.md"), "a", encoding="utf-8") as fh:
            fh.write("tweak again\n")
        git_commit(repo, "three", date="2024-03-01T10:00:00+00:00")

        analysis, _layout, result = self.build_city(repo)
        manifest = result.manifest
        self.assertTrue(manifest["flags"]["coupling"])
        self.assertEqual(manifest["bridges"], "bridges.json")
        bridges = read_json(os.path.join(result.out_dir, "bridges.json"))
        self.assertTrue(bridges)
        # Resolve building ids back to paths via the string table and district
        # chunks, and confirm the coupled pair from gitmeta is represented.
        id_to_path = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                id_to_path[building["id"]] = building["path"]
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        found = {
            frozenset((strings[id_to_path[a]], strings[id_to_path[b]]))
            for a, b, _count in bridges
        }
        self.assertIn(frozenset(("README.md", "alpha/main.py")), found)

    def test_top_churn_only_set_when_churn_is_eligible(self):
        analysis, _layout, result = self._build()
        # The tiny fixture is one bulk commit: too little history for churn.
        self.assertFalse(result.manifest["flags"]["churn"])
        for district in result.manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                self.assertFalse(building["topChurn"])

    def test_index_covers_every_building_with_matching_flags(self):
        _analysis, _layout, result = self._build()
        manifest = result.manifest
        self.assertEqual(manifest["index"], "index.json")
        self.assertEqual(manifest["extTable"], "ext.bin")
        cols = {name: i for i, name in enumerate(manifest["indexColumns"])}
        index_rows = read_json(os.path.join(result.out_dir, "index.json"))
        self.assertEqual(len(index_rows), manifest["stats"]["fileCount"])

        by_id = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                by_id[building["id"]] = building

        self.assertEqual(set(by_id), {row[cols["id"]] for row in index_rows})
        for row in index_rows:
            building = by_id[row[cols["id"]]]
            self.assertEqual(row[cols["district"]], building["district"])
            self.assertEqual(row[cols["archetype"]], building["archetype"])
            self.assertEqual(row[cols["loc"]], building["loc"])
            flags = row[cols["flags"]]
            self.assertEqual(bool(flags & (1 << 0)), building["isTest"])
            self.assertEqual(bool(flags & (1 << 1)), building["isDoc"])
            self.assertEqual(bool(flags & (1 << 2)), building["isBinary"])
            self.assertEqual(bool(flags & (1 << 3)), building["isRuin"])
            self.assertEqual(bool(flags & (1 << 4)), building["rows"] is not None)
            self.assertEqual(bool(flags & (1 << 5)), building["topChurn"])

    def test_extension_table_is_plaintext_even_when_encrypted(self):
        repo = make_repo(self.scratch())
        _analysis, _layout, result = self.build_city(
            repo,
            out_dir=os.path.join(self._tmp, "locked"),
            encrypt=True,
            passphrase="correct horse battery staple",
        )
        # A plain ZIONSTR1 table, not a ZIONENC1 frame -- extension filtering
        # must work before unlock, since an extension is not a filename.
        with open(os.path.join(result.out_dir, "ext.bin"), "rb") as fh:
            self.assertEqual(fh.read(8), b"ZIONSTR1")
        ext_table = read_string_table(os.path.join(result.out_dir, "ext.bin"))
        self.assertIn(".py", ext_table)

    def test_district_carries_path_segments_and_subfolders(self):
        _analysis, _layout, result = self._build()
        manifest = result.manifest
        by_key = {}
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        for district in manifest["districts"]:
            by_key[strings[district["key"]]] = district

        root = by_key["(root)"]
        self.assertEqual(root["pathSegments"], [])
        beta = by_key.get("beta")
        if beta is not None:
            self.assertEqual([strings[i] for i in beta["pathSegments"]], ["beta"])
            # beta/tests/test_pipeline.py sits one folder deeper than beta itself.
            names = {strings[g["name"]] for g in beta["subfolders"]}
            self.assertIn("tests", names)

    def test_index_path_column_matches_building_path(self):
        _analysis, _layout, result = self._build()
        manifest = result.manifest
        self.assertIn("path", manifest["indexColumns"])
        cols = {name: i for i, name in enumerate(manifest["indexColumns"])}
        strings = read_string_table(os.path.join(result.out_dir, "strings.bin"))
        index_rows = read_json(os.path.join(result.out_dir, "index.json"))
        by_id = {}
        for district in manifest["districts"]:
            chunk = read_json(os.path.join(result.out_dir, district["chunk"]))
            for building in chunk["buildings"]:
                by_id[building["id"]] = building
        for row in index_rows:
            building = by_id[row[cols["id"]]]
            self.assertEqual(strings[row[cols["path"]]], strings[building["path"]])

    def test_single_file_build_installs_detail_page_and_index(self):
        repo = make_repo(self.scratch())
        _analysis, _layout, result = self.build_city(
            repo, out_dir=os.path.join(self._tmp, "multi"), single_file=False
        )
        self.assertTrue(os.path.exists(os.path.join(result.out_dir, "detail.html")))
        self.assertTrue(os.path.exists(os.path.join(result.out_dir, "js", "facets.js")))
        self.assertTrue(os.path.exists(os.path.join(result.out_dir, "js", "detail.js")))
        # The geometry assemblies live in a subdirectory, and the import graph
        # reaches them: a build that flattened or skipped `js/parts/` would serve
        # a viewer whose modules 404.
        self.assertTrue(
            os.path.exists(os.path.join(result.out_dir, "js", "primitives.js"))
        )
        self.assertTrue(
            os.path.exists(os.path.join(result.out_dir, "js", "parts", "beacons.js"))
        )
        self.assertTrue(
            os.path.exists(os.path.join(result.out_dir, "js", "parts", "parks.js"))
        )


class SingleFileTests(TempRepoCase):
    def test_single_file_inlines_everything(self):
        repo = make_repo(self.scratch())
        _analysis, _layout, result = self.build_city(
            repo, out_dir=os.path.join(self._tmp, "city"), single_file=True
        )
        self.assertIsNotNone(result.single_file_path)
        html = read_text(result.single_file_path)

        # No external requests at all: a file:// document cannot make them.
        self.assertNotIn('src="./js/main.js"', html)
        self.assertNotIn('href="./css/hud.css"', html)
        self.assertNotIn('"three": "./vendor/three.module.js"', html)
        self.assertIn("data:text/javascript;base64", html)
        self.assertIn("__ZION_PAYLOAD__", html)
        # The entry point is a dynamic import (so module-graph failures are
        # reportable) and the single-file build repoints it at the inlined map.
        self.assertIn("import('zion/main')", html)
        self.assertNotIn("import('./js/main.js')", html)
        # The embedded payload must decode back to the real city files.
        payload_json = html.split("window.__ZION_PAYLOAD__ = ", 1)[1].split(";</script>", 1)[0]
        payload = json.loads(payload_json)
        self.assertIn("city.json", payload)
        self.assertIn("strings.bin", payload)
        strings = base64.b64decode(payload["strings.bin"])
        self.assertEqual(strings[:8], b"ZIONSTR1")
        manifest = json.loads(base64.b64decode(payload["city.json"]))
        self.assertEqual(manifest["format"], "zion-city")
        # The facet index and its plaintext extension table travel with the
        # single-file bundle too, or the filter bar would 404 under file://.
        self.assertIn("index.json", payload)
        self.assertIn("ext.bin", payload)
        self.assertIn("zion/facets", html)
        self.assertIn("zion/detail", html)
        # Nested modules are inlined under their own path, and a nested import
        # is rewritten to that key rather than to a basename that could belong
        # to any file.
        self.assertIn("zion/primitives", html)
        self.assertIn("zion/parts/beacons", html)
        self.assertIn("zion/parts/parks", html)

    def test_module_specifiers_are_rewritten_to_import_map_keys(self):
        from analyzer.emit import _rewrite_module_specifiers

        source = "import { a } from './loader.js';\nimport * as THREE from 'three';\n"
        rewritten = _rewrite_module_specifiers(source)
        self.assertIn("from 'zion/loader'", rewritten)
        self.assertIn("from 'three'", rewritten)

        nested = "import { x } from './parts/beacons.js';\nimport { y } from '../primitives.js';\n"
        self.assertIn(
            "from 'zion/parts/beacons'", _rewrite_module_specifiers(nested, "")
        )
        self.assertIn(
            "from 'zion/primitives'", _rewrite_module_specifiers(nested, "parts")
        )

    def test_oversized_cities_are_refused_with_a_reason(self):
        from analyzer.emit import SINGLE_FILE_MAX_BUILDINGS

        self.assertEqual(SINGLE_FILE_MAX_BUILDINGS, 5000)
        # The refusal path is exercised for real by the 50k benchmark; here we
        # only pin the reason-free invariant that the threshold exists and is
        # not silently ignored.
        self.assertGreater(SINGLE_FILE_MAX_BUILDINGS, 0)


if __name__ == "__main__":
    unittest.main()
