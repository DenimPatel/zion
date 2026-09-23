"""A health grade per folder: one letter an architect can compare at a glance.

The grade is a summary, never a new measurement: it is computed from the same
named per-file signals ``history.SIGNALS`` records in ``summary.json``, so the
grade a folder had at the baseline is computed the same way as the grade it
has now, and a change in letter is a change in the signals underneath it.

Each file contributes its share of the folder's code, times how serious its
signals are (``WEIGHTS``), capped at ``FILE_CAP`` so one file with every flag
cannot count for more than all of itself. The share is by the square root of
logical lines: a hotspot is large by definition, and weighting by raw lines
let one big file decide every folder's letter, while counting files alone
would let a folder of one-liners hide its one troubled module. The score is
100 minus that weighted share (as a percentage); the letter is a fixed cut of
the score:

    A >= 90   B >= 80   C >= 70   D >= 60   F below

Fixed cuts on purpose: a percentile grade would give every repository the
same spread of letters, and "most of this code carries a serious flag" should
read as an F whatever the rest of the repository looks like.
"""

from __future__ import annotations

import math

# How much each signal counts, in "one file fully flagged" units.
WEIGHTS = {
    "hotspot": 1.0,
    "defect": 1.0,
    "cycle": 0.8,
    "violation": 0.6,
    "untested": 0.6,
    "knowledge": 0.6,
    "rising": 0.4,  # on top of hotspot: a hotspot that is getting worse
    "oversized": 0.5,
    "hub": 0.5,
    "clone": 0.4,
    "hiddencoupling": 0.2,
    "orphan": 0.2,
    "drift": 0.2,
}
FILE_CAP = 1.0
CUTS = ((90.0, "A"), (80.0, "B"), (70.0, "C"), (60.0, "D"))


def letter(score: float) -> str:
    for cut, name in CUTS:
        if score >= cut:
            return name
    return "F"


def grade(files) -> dict | None:
    """``files`` is an iterable of ``(logical_loc, set_of_signal_names)``.

    Returns ``{"score", "grade", "why": [[signal, points], ...]}`` -- ``why``
    is how many of the 100 points each signal took, largest first -- or None
    for a folder with no code to grade.
    """
    rows = [(math.sqrt(max(0, int(loc))), signals) for loc, signals in files]
    total = sum(loc for loc, _ in rows)
    if total <= 0:
        return None
    lost = 0.0
    by_signal: dict[str, float] = {}
    for loc, signals in rows:
        if not loc or not signals:
            continue
        weights = {s: WEIGHTS[s] for s in signals if s in WEIGHTS}
        raw = sum(weights.values())
        if raw <= 0:
            continue
        taken = min(FILE_CAP, raw) * loc / total
        lost += taken
        for signal, weight in weights.items():
            by_signal[signal] = by_signal.get(signal, 0.0) + taken * weight / raw
    score = round(max(0.0, 100.0 * (1.0 - lost)), 1)
    why = sorted(([s, round(p * 100, 1)] for s, p in by_signal.items() if p > 0), key=lambda r: (-r[1], r[0]))
    return {"score": score, "grade": letter(score), "why": why}


def signals_of(record) -> set[str]:
    """The named signals a file carries now, as ``history.SIGNALS`` names them."""
    from .history import SIGNALS

    return {name for name, test in SIGNALS if test(record)}


def gradable(record) -> bool:
    from .health import _is_code

    return _is_code(record) and not record.is_test


def current(records) -> dict | None:
    return grade((r.logical_loc, signals_of(r)) for r in records if gradable(r))


def at_baseline(records, baseline: dict | None, key=None) -> dict | None:
    """The same folder's grade from the baseline summary's per-file bits.

    Files are matched by the summary's key (path, or HMAC under --encrypt), so
    a folder is graded on the files it holds now, as they stood then; files
    added since are left out rather than counted as healthy.
    """
    if not baseline:
        return None
    key = key or (lambda rel: rel)
    names = baseline.get("signals") or []
    before = baseline.get("files") or {}
    rows = []
    for record in records:
        if not gradable(record):
            continue
        old = before.get(key(record.rel))
        if old is None:
            continue
        loc, bits = int(old[0]), int(old[1])
        rows.append((loc, {name for i, name in enumerate(names) if bits & (1 << i)}))
    return grade(rows)
