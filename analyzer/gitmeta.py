"""Git metadata from exactly one subprocess.

A single ``git log --numstat`` pass yields author, ISO date and per-file
added/deleted counts for every commit.  That is enough for authorship, churn,
recency *and* co-change coupling (files touched by the same commit).  Running
``git blame`` per file would be O(files) subprocesses and fatal at 50k; this is
one process, streamed.

Degenerate history is expected and handled rather than hidden.  Both reference
repositories have a single author and a single commit date, and
``interactive-courses`` has exactly one commit that touches all 357 files.
Naive co-change coupling on that commit is a complete graph -- 63,546
skybridges -- so bulk commits are excluded from coupling by an explicit rule.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass, field

RECORD = "\x1e"
FIELD = "\x1f"

# A commit is coupling-eligible only if it touched few enough files to express a
# real relationship.  `max(8, ...)` keeps small repos working; the 0.2 fraction
# and the absolute 200 cap together exclude initial and bulk/generated commits.
MIN_ELIGIBLE_FILES = 8
BULK_FRACTION = 0.2
BULK_ABSOLUTE_CAP = 200
MAX_COUPLING_PAIRS = 200_000

# Activity buckets are calendar months, counted back from the repo's own
# newest commit -- never wall-clock "now" -- so an old clone still shows its
# newest files as new, and the test suite stays deterministic regardless of
# when it runs.
ACTIVITY_BUCKETS = 24
BUCKET_DAYS = 30.0
# Half-life for the "hot vs. stable" score: a commit from a month ago counts
# for half as much as one from today, so lifetime churn (which cranes already
# used before this) and *recent* churn tell different stories.
HEAT_HALF_LIFE_DAYS = 30.0


@dataclass
class FileGit:
    authors: dict[str, int] = field(default_factory=dict)  # author -> lines added
    commits: int = 0
    added: int = 0
    deleted: int = 0
    first_ts: float = 0.0
    last_ts: float = 0.0
    last_author: str = ""
    last_message: str = ""
    # Who made the file: the author of its oldest commit in the history
    # walked (renames are not followed, so a moved file is "made" by the move).
    first_author: str = ""
    hashes: list[str] = field(default_factory=list)
    # (timestamp, added+deleted) for every commit touching this file. Kept
    # only long enough to derive `activity`/`recent_churn` below -- it is not
    # itself exposed past gitmeta.py.
    commit_log: list[tuple[float, int]] = field(default_factory=list)
    # author -> timestamp of their newest commit to *this* file, so "who to
    # ask" can prefer the people who worked on it recently over the ones who
    # wrote it years ago (see analyzer/owners.py).
    author_last: dict[str, float] = field(default_factory=dict)
    # author -> the activity buckets (months back from the repo head) in which
    # they touched this file; summed per district into an active-author trend.
    author_buckets: dict[str, set[int]] = field(default_factory=dict)
    _author_log: list[tuple[float, str]] = field(default_factory=list)
    # Filled by `_finalize_activity` once the repo's newest commit is known:
    # monthly commit counts, most recent first, and an exponentially
    # decayed churn score (half-life `HEAT_HALF_LIFE_DAYS`).
    activity: list[int] = field(default_factory=lambda: [0] * ACTIVITY_BUCKETS)
    recent_churn: float = 0.0

    @property
    def primary_author(self) -> str:
        if not self.authors:
            return ""
        return max(self.authors.items(), key=lambda kv: (kv[1], kv[0]))[0]

    @property
    def churn(self) -> int:
        return self.added + self.deleted

    def ownership_share(self) -> float:
        total = sum(self.authors.values())
        if total <= 0:
            return 0.0
        return self.authors.get(self.primary_author, 0) / total


@dataclass
class GitIndex:
    available: bool = False
    reason: str = ""
    files: dict[str, FileGit] = field(default_factory=dict)
    authors: dict[str, int] = field(default_factory=dict)
    commit_count: int = 0
    bulk_commits: int = 0
    eligible_commits: int = 0
    first_ts: float = 0.0
    last_ts: float = 0.0
    active_dates: int = 0
    coupling: dict[tuple[str, str], int] = field(default_factory=dict)
    # author -> timestamp of their newest commit anywhere in the repo, so a
    # file's owner can be told apart from an owner who has since moved on.
    author_last_ts: dict[str, float] = field(default_factory=dict)
    # author name -> every email address they committed with, so CODEOWNERS
    # handles (which are GitHub logins or emails, not display names) can be
    # matched to the people git actually records.
    author_emails: dict[str, set[str]] = field(default_factory=dict)
    head: str = ""  # the commit the history was read up to

    # -- derived confidence signals -------------------------------------
    @property
    def author_count(self) -> int:
        return len(self.authors)

    @property
    def max_eligible_commit_files(self) -> int:
        return self._max_eligible

    _max_eligible: int = 0


def _normalize_path(path: str) -> str:
    """Collapse git's rename notation down to the destination path."""
    if " => " not in path:
        return path
    if "{" in path and "}" in path:
        pre, rest = path.split("{", 1)
        middle, post = rest.split("}", 1)
        new = middle.split(" => ")[-1]
        return (pre + new + post).replace("//", "/")
    return path.split(" => ")[-1]


def _run_git(root: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", root, *args],
        capture_output=True,
    )


def read_git_index(root: str, candidates: set[str] | None = None, rev: str | None = None) -> GitIndex:
    """Read all git-derived metrics in one pass.

    ``candidates`` is the set of paths the walker decided belong to the project;
    commits are still read in full so coupling can see relationships, but only
    candidate paths are recorded. ``rev`` reads the history as of an older
    commit instead of HEAD (``zion.py --compare``); nothing is checked out.
    """
    index = GitIndex()

    probe = _run_git(root, ["rev-parse", "--is-inside-work-tree"])
    if probe.returncode != 0 or probe.stdout.strip() != b"true":
        index.reason = "not a git working tree"
        return index

    tracked = (
        _run_git(root, ["ls-tree", "-r", "--name-only", rev]) if rev else _run_git(root, ["ls-files"])
    )
    tracked_count = len([p for p in tracked.stdout.decode("utf-8", "replace").split("\n") if p])
    if tracked_count == 0:
        index.reason = "no tracked files"
        return index

    eligible_limit = max(MIN_ELIGIBLE_FILES, min(int(tracked_count * BULK_FRACTION), BULK_ABSOLUTE_CAP))

    proc = _run_git(
        root,
        [
            "log",
            f"--pretty=format:{RECORD}%H{FIELD}%an{FIELD}%aI{FIELD}%ae{FIELD}%s",
            "--numstat",
            "--no-renames",
            "--date-order",
            *([rev] if rev else []),
        ],
    )
    if proc.returncode != 0:
        index.reason = "git log failed"
        return index

    text = proc.stdout.decode("utf-8", errors="replace")
    dates_seen: set[str] = set()

    for block in text.split(RECORD):
        block = block.strip("\n")
        if not block.strip():
            continue
        lines = block.split("\n")
        header = lines[0].split(FIELD)
        if len(header) < 5:
            continue
        commit_hash, author, iso_date, email = header[0], header[1], header[2], header[3]
        # The subject is last, so a stray separator inside it cannot shift fields.
        message = FIELD.join(header[4:])
        if not index.head:
            index.head = commit_hash

        entries: list[tuple[str, int, int]] = []
        for line in lines[1:]:
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            added_raw, deleted_raw, path = parts[0], parts[1], parts[2]
            try:
                added = int(added_raw)
            except ValueError:
                added = 0
            try:
                deleted = int(deleted_raw)
            except ValueError:
                deleted = 0
            entries.append((_normalize_path(path), added, deleted))

        if not entries:
            continue

        index.commit_count += 1
        ts = _iso_to_ts(iso_date)
        if ts:
            index.first_ts = ts if not index.first_ts else min(index.first_ts, ts)
            index.last_ts = max(index.last_ts, ts)
            dates_seen.add(iso_date[:10])
            if ts > index.author_last_ts.get(author, 0.0):
                index.author_last_ts[author] = ts
        if email:
            index.author_emails.setdefault(author, set()).add(email.lower())

        if len(entries) > eligible_limit:
            index.bulk_commits += 1
        else:
            index.eligible_commits += 1
            index._max_eligible = max(index._max_eligible, len(entries))
            if len(index.coupling) < MAX_COUPLING_PAIRS:
                paths = sorted({p for p, _, _ in entries})
                for i in range(len(paths)):
                    for j in range(i + 1, len(paths)):
                        key = (paths[i], paths[j])
                        index.coupling[key] = index.coupling.get(key, 0) + 1

        for path, added, deleted in entries:
            if candidates is not None and path not in candidates:
                continue
            record = index.files.setdefault(path, FileGit())
            record.authors[author] = record.authors.get(author, 0) + added
            record.commits += 1
            record.added += added
            record.deleted += deleted
            record.hashes.append(commit_hash)
            if ts:
                if not record.first_ts or ts <= record.first_ts:
                    record.first_author = author
                record.first_ts = ts if not record.first_ts else min(record.first_ts, ts)
                record.commit_log.append((ts, added + deleted))
                record._author_log.append((ts, author))
                if ts > record.author_last.get(author, 0.0):
                    record.author_last[author] = ts
            if ts >= record.last_ts:
                record.last_ts = ts
                record.last_author = author
                record.last_message = message
            index.authors[author] = index.authors.get(author, 0) + added

    index.active_dates = len(dates_seen)
    index.available = index.commit_count > 0
    if not index.available:
        index.reason = "no commit history"
        return index

    _finalize_activity(index)
    return index


def _finalize_activity(index: "GitIndex") -> None:
    """Turn each file's raw commit log into monthly buckets and a heat score.

    Both are relative to the *repo's* newest commit (``index.last_ts``), never
    wall-clock time: an old clone should show its own newest files as new, and
    the buckets must not shift every time the test suite runs.
    """
    now = index.last_ts
    for record in index.files.values():
        for ts, churn in record.commit_log:
            days_ago = max(0.0, (now - ts) / 86400.0)
            bucket = min(ACTIVITY_BUCKETS - 1, int(days_ago // BUCKET_DAYS))
            record.activity[bucket] += 1
            record.recent_churn += churn * (0.5 ** (days_ago / HEAT_HALF_LIFE_DAYS))
        for ts, author in record._author_log:
            days_ago = max(0.0, (now - ts) / 86400.0)
            if days_ago < ACTIVITY_BUCKETS * BUCKET_DAYS:
                record.author_buckets.setdefault(author, set()).add(int(days_ago // BUCKET_DAYS))
        # The raw logs are only a scratch pad for the derived fields above.
        record.commit_log = []
        record._author_log = []


def _iso_to_ts(iso: str) -> float:
    """Parse an ISO-8601 date from git without requiring Python 3.11's fromisoformat quirks."""
    iso = iso.strip()
    if not iso:
        return 0.0
    candidate = iso.replace("Z", "+00:00")
    try:
        import datetime as _dt

        return _dt.datetime.fromisoformat(candidate).timestamp()
    except ValueError:
        try:
            import datetime as _dt

            return _dt.datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").timestamp()
        except ValueError:
            return 0.0


def days_since(ts: float, now: float | None = None) -> float:
    if not ts:
        return 0.0
    now = now if now is not None else time.time()
    return max(0.0, (now - ts) / 86400.0)
