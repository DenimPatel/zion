"""Walker tests: what belongs to the project, and what does not."""

from __future__ import annotations

import os
import unittest

from support import NOISE_FILES, TempRepoCase, make_repo

from analyzer.walk import FileWalker


class WalkerTests(TempRepoCase):
    def test_git_first_excludes_ignored_files(self):
        repo = make_repo(self.scratch())
        result = FileWalker(repo).walk()

        self.assertEqual(result.source, "git")
        rels = {e.rel for e in result.files}
        for noisy in NOISE_FILES:
            self.assertNotIn(noisy, rels, f"{noisy} should be excluded")
        # The injected noise is reported, not silently dropped.
        self.assertGreaterEqual(result.noise_excluded, len(NOISE_FILES))
        self.assertIn("alpha/main.py", rels)
        self.assertIn("delta gamma/thing.js", rels)

    def test_include_noise_walks_the_filesystem(self):
        repo = make_repo(self.scratch())
        clean = FileWalker(repo).walk()
        noisy = FileWalker(repo, include_noise=True).walk()

        self.assertEqual(noisy.source, "walk-all")
        self.assertGreater(len(noisy.files), len(clean.files))
        rels = {e.rel for e in noisy.files}
        self.assertIn("debug.log", rels)
        self.assertIn(".DS_Store", rels)

    def test_paths_with_spaces_survive(self):
        repo = make_repo(self.scratch())
        rels = {e.rel for e in FileWalker(repo).walk().files}
        self.assertIn("delta gamma/thing.js", rels)

    def test_non_git_directory_falls_back_to_noise_rules(self):
        repo = make_repo(self.scratch(), init=False, commit=False)
        result = FileWalker(repo).walk()
        self.assertEqual(result.source, "walk")
        rels = {e.rel for e in result.files}
        self.assertNotIn("debug.log", rels)
        self.assertNotIn("build/ignored.py", rels)

    def test_binary_detection(self):
        repo = make_repo(self.scratch())
        result = FileWalker(repo).walk()
        by_rel = {e.rel: e for e in result.files}
        self.assertFalse(by_rel["alpha/main.py"].is_binary)
        self.assertFalse(by_rel["huge.json"].is_binary)

    def test_gitignored_directory_contents_are_absent(self):
        repo = make_repo(self.scratch())
        rels = {e.rel for e in FileWalker(repo).walk().files}
        self.assertFalse(any(r.startswith("build/") for r in rels))
        self.assertFalse(any("__pycache__" in r for r in rels))

    def test_max_buildings_truncates_and_reports(self):
        repo = make_repo(self.scratch())
        result = FileWalker(repo, max_buildings=3).walk()
        self.assertEqual(len(result.files), 3)
        self.assertTrue(result.truncated)


if __name__ == "__main__":
    unittest.main()
