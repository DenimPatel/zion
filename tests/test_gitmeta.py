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

    def test_first_ts_is_the_earliest_commit_touching_a_file(self):
        repo = self.scratch()
        make_repo(repo, commit=False)
        git_commit(repo, "one", date="2024-01-01T10:00:00+00:00")
        with open(f"{repo}/alpha/main.py", "a", encoding="utf-8") as fh:
            fh.write("\n# revision\n")
        git_commit(repo, "two", date="2024-06-01T10:00:00+00:00")

        index = read_git_index(repo)
        record = index.files["alpha/main.py"]
        # Touched by both commits: born at the first one, last touched at the
        # second -- and the two must not collapse into each other.
        self.assertLess(record.first_ts, record.last_ts)
        # README.md was only touched by the first commit in make_repo's default
        # template, so its birth and its last touch are the same commit.
        readme = index.files.get("README.md")
        if readme is not None:
            self.assertLessEqual(readme.first_ts, readme.last_ts)

    def test_activity_buckets_are_relative_to_the_repos_own_newest_commit(self):
        repo = self.scratch()
        make_repo(repo, commit=False)
        git_commit(repo, "one", date="2024-01-01T10:00:00+00:00")
        with open(f"{repo}/alpha/main.py", "a", encoding="utf-8") as fh:
            fh.write("\n# revision\n")
        git_commit(repo, "two", date="2024-06-01T10:00:00+00:00")

        index = read_git_index(repo)
        record = index.files["alpha/main.py"]
        # The commit at index.last_ts itself falls in bucket 0 ("this month").
        self.assertEqual(sum(record.activity), record.commits)
        self.assertGreater(record.activity[0], 0)

    def test_recent_churn_favours_a_burst_near_the_repos_newest_commit(self):
        # One repo, one commit history: a burst on alpha/main.py happens right
        # after the initial commit (270 days before the repo's own newest
        # commit), and an equal-sized burst on beta/pipeline.py happens *at*
        # the repo's newest commit. Equal raw churn, very different recency.
        repo = self.scratch()
        make_repo(repo, commit=False)
        git_commit(repo, "initial", date="2023-01-01T10:00:00+00:00")
        with open(f"{repo}/alpha/main.py", "a", encoding="utf-8") as fh:
            fh.write("\n" + "x = 1\n" * 20)
        git_commit(repo, "old burst on alpha", date="2023-01-31T10:00:00+00:00")
        with open(f"{repo}/beta/pipeline.py", "a", encoding="utf-8") as fh:
            fh.write("\n" + "x = 1\n" * 20)
        git_commit(repo, "recent burst on beta", date="2023-10-28T10:00:00+00:00")

        index = read_git_index(repo)
        old_burst = index.files["alpha/main.py"].recent_churn
        recent_burst = index.files["beta/pipeline.py"].recent_churn
        self.assertGreater(recent_burst, old_burst)


if __name__ == "__main__":
    unittest.main()
