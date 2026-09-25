"""Clone twins: files that share a substantial block of near-identical code.

Copy-and-paste is how duplicated logic starts, and duplicated logic is how a
fix lands in one place and not the other. This finds it with the standard
document-fingerprinting technique (winnowing, as used by MOSS), in pure
standard library:

1. **Normalise** each line: strip whitespace, drop blank and comment-only
   lines, replace every string and number literal with a placeholder and every
   identifier that is not a keyword with ``I``. A renamed variable is still a
   copy; a reformatted file is still a copy.
2. **Hash k-grams** of consecutive normalised lines (``K_LINES``), skipping the
   trivial lines (a lone ``}``, ``return I``) that every file shares.
3. **Winnow**: keep the minimum hash of every window of ``WINDOW`` k-grams.
   Any shared run of at least ``K_LINES + WINDOW - 1`` lines is guaranteed to
   produce at least one shared fingerprint.
4. **Pair** files through an inverted index (fingerprint -> files), ignoring
   fingerprints so common they are boilerplate, and call two files twins when
   they share at least half of the smaller one's fingerprints, or a long run
   outright.

Tests, vendored code and non-code files are left out: a test suite is
repetitive by design, and a vendored copy is not this repository's to merge.
"""

from __future__ import annotations

import re
import zlib

K_LINES = 6
WINDOW = 4
MAX_SOURCE_BYTES = 400_000  # a generated blob is not a copy-paste candidate
MIN_LINE_CHARS = 6  # normalised lines shorter than this carry no identity
BOILERPLATE_FILES = 12  # a fingerprint in more files than this is an idiom
SHARE_RATIO = 0.5
SHARE_ABSOLUTE = 12
MAX_PARTNERS = 8

_KEYWORDS = frozenset(
    """
    and as assert async await break case catch class const continue def default del do elif else
    enum except export extends final finally fn for from func function go if impl import in
    interface is lambda let loop match mod new nil none not null or package pass private protected
    pub public raise return self static struct super switch this throw throws trait try type
    typeof use var void while with yield true false True False None
    """.split()
)
_STRING = re.compile(r"(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`[^`]*`)")
_NUMBER = re.compile(r"\b\d[\d_.xXa-fA-F]*\b")
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
_COMMENT_START = ("#", "//", "/*", "*", "--", "<!--")


def _normalise(line: str) -> str:
    text = line.strip()
    if not text or text.startswith(_COMMENT_START):
        return ""
    text = _STRING.sub("S", text)
    text = _NUMBER.sub("N", text)
    text = _IDENT.sub(lambda m: m.group(0) if m.group(0) in _KEYWORDS else "I", text)
    return re.sub(r"\s+", "", text)


def fingerprint(source: str) -> list[int]:
    """Winnowed fingerprints of one file's normalised source, sorted and unique."""
    if len(source) > MAX_SOURCE_BYTES:
        return []
    lines = [n for n in (_normalise(line) for line in source.splitlines()) if len(n) >= MIN_LINE_CHARS]
    if len(lines) < K_LINES:
        return []
    grams = [zlib.crc32("\n".join(lines[i : i + K_LINES]).encode("utf-8")) for i in range(len(lines) - K_LINES + 1)]
    if len(grams) <= WINDOW:
        return [min(grams)]
    chosen: set[int] = set()
    for i in range(len(grams) - WINDOW + 1):
        chosen.add(min(grams[i : i + WINDOW]))
    return sorted(chosen)


def _eligible(record) -> bool:
    from .health import is_vendored

    return bool(record.fingerprints) and not record.is_test and not is_vendored(record.rel)


def finalize_clones(analysis) -> list[tuple[str, str, float, int]]:
    """Mark clone twins on every file; return the pairs, strongest first.

    Each pair is ``(a, b, ratio, shared)``: ``ratio`` is the share of the
    smaller file's fingerprints the two have in common, ``shared`` the count.
    """
    files = [f for f in analysis.files if _eligible(f)]
    index: dict[int, list[int]] = {}
    for position, record in enumerate(files):
        for fp in record.fingerprints:
            index.setdefault(fp, []).append(position)

    shared: dict[tuple[int, int], int] = {}
    for members in index.values():
        if len(members) < 2 or len(members) > BOILERPLATE_FILES:
            continue
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                key = (members[i], members[j])
                shared[key] = shared.get(key, 0) + 1

    pairs: list[tuple[str, str, float, int]] = []
    for (i, j), count in shared.items():
        a, b = files[i], files[j]
        smaller = max(1, min(len(a.fingerprints), len(b.fingerprints)))
        ratio = count / smaller
        if ratio >= SHARE_RATIO and count >= 2 or count >= SHARE_ABSOLUTE:
            pairs.append((a.rel, b.rel, round(min(1.0, ratio), 3), count))
    pairs.sort(key=lambda p: (-p[3], -p[2], p[0], p[1]))

    by_rel = {f.rel: f for f in analysis.files}
    for a, b, ratio, count in pairs:
        for this, other in ((a, b), (b, a)):
            record = by_rel[this]
            if len(record.clone_of) < MAX_PARTNERS:
                record.clone_of.append((other, ratio))
            record.is_clone = True
    analysis.clones = pairs
    analysis.flags.clones = bool(pairs)
    # The fingerprints were only a scratch pad; do not carry them into emit.
    for record in analysis.files:
        record.fingerprints = []
    return pairs
