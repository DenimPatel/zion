"""Git layer tests: one pass, and the bulk-commit rule that keeps it honest."""

from __future__ import annotations

import unittest

from support import TempRepoCase, git_commit, make_repo

from analyzer.gitmeta import BULK_ABSOLUTE_CAP, read_git_index


class GitIndexTests(TempRepoCase):
    def test_single_commit_that_touches_everything_is_bulk(self):
        """The large reference repo's exact shape: 1 commit, all files.

        Naive coupling on that commit is a complete graph, so it must be
        excluded rather than drawn.
        """
        repo = make_repo(self.scratch(), authors=("Ada Lovelace",), dates=("2024-01-01T10:00:00+00:00",))
        index = read_git_index(repo)

        self.assertTrue(index.available)
        self.assertEqual(index.commit_count, 1)
        self.assertEqual(index.eligible_commits, 0)
        self.assertEqual(index.bulk_commits, 1)
        self.assertEqual(index.coupling, {})

    def test_small_commits_produce_coupling(self):
        repo = make_repo(self.scratch(), commit=False)
        git_commit(repo, "one", date="2024-01-01T10:00:00+00:00")
        # Two later commits each touching a small, overlapping set.
        with open(f"{repo}/alpha/main.py", "a", encoding="utf-8") as fh:
            fh.write("\n# tweak one\n")
        with open(f"{repo}/README.md", "a", encoding="utf-8") as fh:
            fh.write("\ntweak\n")
        git_commit(repo, "two", date="2024-02-01T10:00:00+00:00")
        with open(f"{repo}/alpha/main.py", "a", encoding="utf-8") as fh:
            fh.write("# tweak two\n")
        with open(f"{repo}/README.md", "a", encoding="utf-8") as fh:
            fh.write("tweak again\n")
        git_commit(repo, "three", date="2024-03-01T10:00:00+00:00")

        index = read_git_index(repo)
        self.assertGreaterEqual(index.eligible_commits, 2)
        key = ("README.md", "alpha/main.py")
        self.assertIn(key, index.coupling)
        self.assertGreaterEqual(index.coupling[key], 2)

    def test_authors_and_dates_are_counted(self):
        repo = make_repo(
            self.scratch(),
            authors=("Ada Lovelace", "Grace Hopper"),
            dates=("2024-01-01T10:00:00+00:00", "2024-02-01T10:00:00+00:00", "2024-03-01T10:00:00+00:00"),
        )
        index = read_git_index(repo)
        self.assertEqual(index.author_count, 2)
        self.assertEqual(index.active_dates, 3)
        self.assertEqual(index.commit_count, 3)

    def test_missing_git_history_is_reported_not_guessed(self):
        repo = make_repo(self.scratch(), init=False, commit=False)
        index = read_git_index(repo)
        self.assertFalse(index.available)
        self.assertTrue(index.reason)

    def test_per_file_metrics(self):
        repo = make_repo(self.scratch())
        index = read_git_index(repo)
        record = index.files["alpha/main.py"]
        self.assertEqual(record.commits, 1)
        self.assertEqual(record.primary_author, "Ada Lovelace")
        self.assertGreater(record.added, 0)

    def test_bulk_cap_bounds_what_can_be_eligible(self):
        # The eligibility ceiling must never exceed the hard cap, or a huge repo
        # would build a complete graph out of a generated commit.
        self.assertEqual(BULK_ABSOLUTE_CAP, 200)


if __name__ == "__main__":
    unittest.main()
