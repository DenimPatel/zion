"""Emit tests: the output is a self-contained website, and indices resolve."""

from __future__ import annotations

import json
import os
import unittest

from support import (
    TempRepoCase,
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
            indices.append(entry["label"])
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


if __name__ == "__main__":
    unittest.main()
