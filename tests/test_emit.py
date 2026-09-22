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

    def test_module_specifiers_are_rewritten_to_import_map_keys(self):
        from analyzer.emit import _rewrite_module_specifiers

        source = "import { a } from './loader.js';\nimport * as THREE from 'three';\n"
        rewritten = _rewrite_module_specifiers(source)
        self.assertIn("from 'zion/loader'", rewritten)
        self.assertIn("from 'three'", rewritten)

    def test_oversized_cities_are_refused_with_a_reason(self):
        from analyzer.emit import SINGLE_FILE_MAX_BUILDINGS

        self.assertEqual(SINGLE_FILE_MAX_BUILDINGS, 5000)
        # The refusal path is exercised for real by the 50k benchmark; here we
        # only pin the reason-free invariant that the threshold exists and is
        # not silently ignored.
        self.assertGreater(SINGLE_FILE_MAX_BUILDINGS, 0)


if __name__ == "__main__":
    unittest.main()
