"""Ownership as declared versus ownership as practised.

Two questions a long-lived repository keeps asking:

- **Who should I ask about this?** Not necessarily whoever wrote most of it:
  the person who wrote it four years ago may have moved on. Each file's
  *experts* are its authors ranked by the lines they added, discounted by how
  long ago they last touched *this file* (half-life 180 days), so an active
  maintainer outranks a departed founder.
- **Does CODEOWNERS still describe reality?** A ``CODEOWNERS`` file (root,
  ``.github/`` or ``docs/``, read only) names who reviews each path. When the
  individuals it names for a file are people who commit to this repository but
  not to that file, the declared owner has drifted from the real one. A path no
  rule covers is *unowned*. Teams (``@org/team``) cannot be resolved from git
  history, so a file owned only by teams is never called drifted.

Handles are matched to git authors by display name and by email (including
GitHub's ``id+login@users.noreply.github.com`` form), case- and
punctuation-insensitively. Matching is best-effort by nature; the report says
so.
"""

from __future__ import annotations

import os
import re

from .health import _is_code

CODEOWNERS_PATHS = ("CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS")
EXPERT_HALF_LIFE_DAYS = 180.0
MAX_EXPERTS = 3
MAX_AUTHOR_SHARES = 5
# A declared owner counts as a real one if they wrote at least this share.
ALIGNED_SHARE = 0.10


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _pattern_regex(pattern: str) -> re.Pattern:
    """gitignore-style CODEOWNERS pattern -> regex over a POSIX relative path."""
    directory = pattern.endswith("/")
    body = pattern.strip("/")
    anchored = pattern.startswith("/") or "/" in body
    out = []
    i = 0
    while i < len(body):
        if body.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif body.startswith("/**", i) and i + 3 == len(body):
            out.append("(?:/.*)?")
            i += 3
        elif body.startswith("**", i):
            out.append(".*")
            i += 2
        elif body[i] == "*":
            out.append("[^/]*")
            i += 1
        elif body[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(body[i]))
            i += 1
    core = "".join(out)
    tail = "/.*" if directory else "(?:/.*)?"
    prefix = "^" if anchored else "(?:^|.*/)"
    return re.compile(prefix + core + tail + "$")


def parse_codeowners(text: str) -> list[tuple[re.Pattern, list[str]]]:
    rules = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        # A trailing comment is allowed after whitespace.
        line = re.split(r"\s+#", line, maxsplit=1)[0]
        parts = line.split()
        if not parts:
            continue
        rules.append((_pattern_regex(parts[0]), parts[1:]))
    return rules


def owners_for(rel: str, rules: list[tuple[re.Pattern, list[str]]]) -> list[str] | None:
    """The owners of the last matching rule (CODEOWNERS semantics), or None."""
    found = None
    for regex, owners in rules:
        if regex.match(rel):
            found = owners
    return found


def load_codeowners(root: str) -> tuple[str, list[tuple[re.Pattern, list[str]]]]:
    for rel in CODEOWNERS_PATHS:
        path = os.path.join(root, rel)
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    return rel, parse_codeowners(fh.read())
            except OSError:
                return rel, []
    return "", []


def _identity_keys(git) -> dict[str, str]:
    """Normalised name / email / login -> the git author name it belongs to."""
    keys: dict[str, str] = {}
    for author in git.authors if git is not None else ():
        keys.setdefault(_norm(author), author)
    for author, emails in (git.author_emails if git is not None else {}).items():
        for email in emails:
            keys.setdefault(_norm(email), author)
            local = email.split("@", 1)[0]
            if "+" in local and email.endswith("users.noreply.github.com"):
                local = local.split("+", 1)[1]
            keys.setdefault(_norm(local), author)
    return keys


def resolve_owner(owner: str, keys: dict[str, str]) -> str | None:
    """A CODEOWNERS entry -> a git author name, or None (a team, or unknown)."""
    if owner.startswith("@") and "/" in owner:
        return None  # @org/team: membership is not in the history
    handle = owner[1:] if owner.startswith("@") else owner
    return keys.get(_norm(handle))


def finalize_owners(analysis, git) -> None:
    files = analysis.files
    flags = analysis.flags
    head = git.last_ts if git is not None and git.available else 0.0

    # -- experts and author shares -------------------------------------------
    for record in files:
        file_git = git.files.get(record.rel) if git is not None else None
        total = sum(v for v in record.authors.values() if v > 0)
        record.author_shares = [
            (author, round(lines / total, 4))
            for author, lines in sorted(record.authors.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_AUTHOR_SHARES]
            if lines > 0
        ] if total else []
        scores: dict[str, float] = {}
        if file_git is not None and head:
            for author, lines in record.authors.items():
                last = file_git.author_last.get(author, 0.0)
                away = max(0.0, (head - last) / 86400.0) if last else 10_000.0
                scores[author] = max(0, lines) * (0.5 ** (away / EXPERT_HALF_LIFE_DAYS))
        record.expert_scores = scores
        score_total = sum(scores.values())
        record.experts = [
            (author, round(score / score_total, 4))
            for author, score in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_EXPERTS]
            if score > 0
        ] if score_total else []

    # -- CODEOWNERS -------------------------------------------------------------
    rel, rules = load_codeowners(analysis.root)
    analysis.codeowners_path = rel
    flags.codeowners = bool(rules)
    if rel and not rules:
        flags.notes.append(f"{rel} has no rules - ownership drift disabled.")
    if not rules:
        return
    keys = _identity_keys(git)
    for record in files:
        declared = owners_for(record.rel, rules)
        record.declared_owners = list(declared or [])
        if not _is_code(record) or record.is_ruin:
            continue
        if not declared:
            record.is_unowned = True
            continue
        resolved = {resolve_owner(o, keys) for o in declared} - {None}
        if not resolved or not record.authors:
            continue
        total = sum(v for v in record.authors.values() if v > 0) or 1
        aligned = any(
            author == record.primary_author or record.authors.get(author, 0) / total >= ALIGNED_SHARE
            for author in resolved
        )
        record.owner_drift = not aligned
