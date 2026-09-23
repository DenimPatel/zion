"""Change over time: what moved since the last build, or since a release.

A city is a snapshot. Keeping a repository healthy is about direction, so
every build also writes a small ``summary.json`` next to the city: per file,
its logical lines and which architect's signals it carries; per repository,
the totals. The next build into the same directory compares itself against
it, and ``zion.py build --compare REV`` compares against the repository as it
was at any commit, analysed in a temporary directory (``git archive``, read
only -- nothing is checked out in the analyzed repository).

The result is a *delta*: files added, grown and shrunk; files that became a
hotspot, joined a cycle or broke a layering rule; files that stopped being
one; removed files; and the before/after totals for the trend line.

Summaries of an encrypted city are keyed by ``HMAC(passphrase, path)`` rather
than the path, so the summary leaks nothing the city itself does not; removed
files are then counted but cannot be named.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import tarfile
import tempfile

SUMMARY_FILE = "summary.json"
PREVIOUS_FILE = "summary.prev.json"
SUMMARY_FORMAT = "zion-summary"

# Per-file signal bits in a summary. Append-only.
SIGNALS = (
    ("hotspot", lambda f: f.is_hotspot),
    ("oversized", lambda f: f.is_oversized),
    ("cycle", lambda f: bool(f.cycle_id)),
    ("violation", lambda f: f.is_violation),
    ("orphan", lambda f: f.is_orphan),
    ("knowledge", lambda f: f.knowledge_risk),
    ("untested", lambda f: f.untested_risk),
    ("drift", lambda f: f.owner_drift),
    # Appended: a summary names its signals, so older summaries still read.
    ("defect", lambda f: f.is_defect),
    ("rising", lambda f: f.is_rising_hotspot),
    ("hub", lambda f: f.is_hub),
    ("clone", lambda f: f.is_clone),
    ("hiddencoupling", lambda f: f.is_hidden_coupling),
)
GROWTH_MIN_LINES = 10
GROWTH_MIN_FRACTION = 0.1


def key_function(passphrase: str | None):
    if not passphrase:
        return (lambda rel: rel), "path"
    secret = passphrase.encode("utf-8")
    return (lambda rel: hmac.new(secret, rel.encode("utf-8"), hashlib.sha256).hexdigest()[:24]), "hmac"


def _bits(record) -> int:
    value = 0
    for position, (_name, test) in enumerate(SIGNALS):
        if test(record):
            value |= 1 << position
    return value


def totals(analysis) -> dict:
    files = analysis.files
    arch = getattr(analysis, "architecture", None)
    return {
        "files": len(files),
        "loc": analysis.total_logical_loc,
        "documented": analysis.documented_files,
        "hotspots": sum(1 for f in files if f.is_hotspot),
        "oversized": sum(1 for f in files if f.is_oversized),
        "cycles": len(analysis.cycles),
        "violations": len(arch.violations) if arch is not None else 0,
        "orphans": sum(1 for f in files if f.is_orphan),
        "knowledge": sum(1 for f in files if f.knowledge_risk),
        "untested": sum(1 for f in files if f.untested_risk),
        "drift": sum(1 for f in files if f.owner_drift),
        "defects": sum(1 for f in files if f.is_defect),
        "rising": sum(1 for f in files if f.is_rising_hotspot),
        "hubs": sum(1 for f in files if f.is_hub),
        "clones": len(getattr(analysis, "clones", []) or []),
        "hiddenCoupling": len(getattr(analysis, "hidden_couplings", []) or []),
        "debt": sum(len(f.debt) for f in files),
        "zonePain": sum(1 for d in (arch.districts.values() if arch is not None else []) if d.zone == "pain"),
    }


def summarize(analysis, key=None, keying: str = "path", label: str = "") -> dict:
    key = key or (lambda rel: rel)
    git = analysis.git
    return {
        "format": SUMMARY_FORMAT,
        "version": 1,
        "keying": keying,
        "root": hashlib.sha256(os.path.abspath(analysis.root).encode("utf-8")).hexdigest()[:16],
        "generated": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "head": git.head if git is not None else "",
        "headTs": git.last_ts if git is not None else 0.0,
        "label": label,
        "signals": [name for name, _ in SIGNALS],
        "files": {key(f.rel): [f.logical_loc, _bits(f)] for f in analysis.files},
        "totals": totals(analysis),
    }


def load_summary(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("format") != SUMMARY_FORMAT:
        return None
    return data


def previous_baseline(out_dir: str, current: dict) -> dict | None:
    """The summary a build into `out_dir` should compare itself to.

    The last build's, unless it was of the same commit -- then the one before
    that, so rebuilding a commit keeps showing what that commit changed rather
    than an empty delta.
    """
    last = load_summary(os.path.join(out_dir, SUMMARY_FILE))
    if last is None or last.get("root") != current.get("root") or last.get("keying") != current.get("keying"):
        return None
    if last.get("head") and last.get("head") == current.get("head"):
        before = load_summary(os.path.join(out_dir, PREVIOUS_FILE))
        if before is not None and before.get("root") == current.get("root") and before.get("keying") == current.get("keying"):
            return before
    return last


def write_summaries(out_dir: str, current: dict) -> int:
    """Rotate: the last build's summary becomes `summary.prev.json` when the head moved."""
    written = 0
    last_path = os.path.join(out_dir, SUMMARY_FILE)
    last = load_summary(last_path)
    if last is not None and last.get("head") != current.get("head") and last.get("root") == current.get("root"):
        shutil.copyfile(last_path, os.path.join(out_dir, PREVIOUS_FILE))
    data = json.dumps(current, separators=(",", ":")).encode("utf-8")
    os.makedirs(out_dir, exist_ok=True)
    with open(last_path, "wb") as fh:
        fh.write(data)
    written += len(data)
    return written


def apply_delta(analysis, baseline: dict | None, key=None) -> dict | None:
    """Mark every file's change against `baseline` and return the delta."""
    key = key or (lambda rel: rel)
    for record in analysis.files:
        record.delta = ""
        record.loc_delta = 0
        record.became = []
    if not baseline:
        return None
    names = baseline.get("signals") or [name for name, _ in SIGNALS]
    before_files: dict = baseline.get("files") or {}
    seen = set()
    added, grown, shrunk = [], [], []
    became: dict[str, list[str]] = {name: [] for name, _ in SIGNALS}
    resolved: dict[str, int] = {name: 0 for name, _ in SIGNALS}
    for record in analysis.files:
        k = key(record.rel)
        seen.add(k)
        old = before_files.get(k)
        bits_now = _bits(record)
        if old is None:
            record.delta = "added"
            added.append(record.rel)
            continue
        old_loc, old_bits = int(old[0]), int(old[1])
        change = record.logical_loc - old_loc
        record.loc_delta = change
        if abs(change) >= GROWTH_MIN_LINES and abs(change) >= GROWTH_MIN_FRACTION * max(1, old_loc):
            record.delta = "grown" if change > 0 else "shrunk"
            (grown if change > 0 else shrunk).append((record.rel, change))
        for position, (name, _test) in enumerate(SIGNALS):
            # A signal the baseline never recorded cannot have been "gained":
            # comparing against an older summary must not call every file
            # that carries it new.
            if name not in names:
                continue
            was = bool(old_bits & (1 << names.index(name)))
            now = bool(bits_now & (1 << position))
            if now and not was:
                became[name].append(record.rel)
                record.became.append(name)
            elif was and not now:
                resolved[name] += 1
    removed = [(k, int(v[0])) for k, v in before_files.items() if k not in seen]
    removed.sort(key=lambda kv: (-kv[1], kv[0]))
    grown.sort(key=lambda kv: -kv[1])
    shrunk.sort(key=lambda kv: kv[1])
    return {
        "baseline": {
            "generated": baseline.get("generated", ""),
            "head": baseline.get("head", ""),
            "headTs": baseline.get("headTs", 0.0),
            "label": baseline.get("label", ""),
            "keying": baseline.get("keying", "path"),
        },
        "added": sorted(added),
        "grown": grown,
        "shrunk": shrunk,
        "removed": removed,
        "became": became,
        "resolved": resolved,
        "before": baseline.get("totals") or {},
        "after": totals(analysis),
    }


# --------------------------------------------------------------------------
# Analysis of an older revision
# --------------------------------------------------------------------------


def _git(root: str, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", root, *args], capture_output=True)


def resolve_revision(root: str, rev: str) -> str:
    proc = _git(root, ["rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"])
    if proc.returncode != 0:
        raise ValueError(f"not a commit in this repository: {rev}")
    return proc.stdout.decode().strip()


def _extract(root: str, sha: str, target: str) -> None:
    """`git archive` the revision into `target` (outside the analyzed repo)."""
    proc = _git(root, ["archive", "--format=tar", sha])
    if proc.returncode != 0:
        raise ValueError(f"git archive failed for {sha}: {proc.stderr.decode(errors='replace').strip()}")
    import io

    with tarfile.open(fileobj=io.BytesIO(proc.stdout)) as archive:
        base = os.path.realpath(target)
        for member in archive.getmembers():
            if not (member.isfile() or member.isdir()):
                continue  # no links, devices or fifos from an archive
            destination = os.path.realpath(os.path.join(target, member.name))
            if not destination.startswith(base + os.sep):
                continue
            if member.isdir():
                os.makedirs(destination, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                continue
            with open(destination, "wb") as fh:
                shutil.copyfileobj(source, fh)


def analyze_revision(root: str, rev: str, include_noise: bool = False, max_buildings: int | None = None):
    """The analysis (and layout) of `root` as it was at `rev`.

    Returns ``(analysis, sha)``. The tree is extracted into a temporary
    directory and removed afterwards; git history is read up to `rev`.
    """
    from .gitmeta import read_git_index
    from .layout import build_layout
    from .metrics import analyze
    from .walk import _classify

    root = os.path.abspath(root)
    sha = resolve_revision(root, rev)
    listing = _git(root, ["ls-tree", "-r", "-z", "--name-only", sha])
    rels = sorted(p for p in listing.stdout.decode("utf-8", "replace").split("\0") if p)
    scratch = tempfile.mkdtemp(prefix="zion-rev-")
    try:
        _extract(root, sha, scratch)
        entries = [e for e in (_classify(scratch, rel) for rel in rels) if e is not None]
        if max_buildings is not None:
            entries = entries[:max_buildings]
        git = read_git_index(root, {e.rel for e in entries}, rev=sha)
        analysis = analyze(scratch, entries, git, include_noise=include_noise)
        build_layout(analysis)
        # Paths and summaries are relative, but the root identity must be the
        # real repository's for a baseline to be accepted.
        analysis.root = root
        return analysis, sha
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
