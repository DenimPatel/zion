"""Per-file metrics, repo-level confidence, and the degeneration rules.

Height never comes from bytes.  For code it comes from logical source lines, for
data files from streamed row counts, for binary artefacts from nothing at all
(they are monuments).

Every dimension that can be degenerate carries a confidence flag.  A repo with
one author, one commit date, or a single commit that touched every file must
still produce a small, clean, *correct* city -- so the viewer is told which
legend entries to drop instead of being handed a one-value scale.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field

from . import parse as parse_pkg
from .gitmeta import GitIndex, days_since
from .parse import Floor
from .walk import FileEntry

# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

# Whole path segments that mark test code.  Matching must be exact: the large
# reference repo contains `hypothesis-testing/`, `test-zoo/` and `testing/`,
# all of which are real content directories and none of which are parks.
TEST_DIR_SEGMENTS = frozenset({"tests", "test", "__tests__", "spec", "specs", "testdata"})
TEST_FILE_PATTERNS = (
    re.compile(r"^test_.*\.py$"),
    re.compile(r"^.*_test\.(py|go|rb|js|ts)$"),
    re.compile(r"^.*\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$"),
    re.compile(r"^.*(Test|Tests|Spec)\.(java|kt|scala|cs)$"),
    re.compile(r"^conftest\.py$"),
)

# Town Hall means "this folder has its own README".  `index.md` is deliberately
# NOT here: the large reference repo has 17 `index.md` course pages, and treating
# them as READMEs would put a Town Hall in most districts and silently invert the
# single most useful finding the tool reports.
DOC_NAMES = frozenset({"readme.md", "readme.rst", "readme.txt", "readme", "readme.markdown"})
CONFIG_NAMES = frozenset(
    {
        "pyproject.toml", "setup.py", "setup.cfg", "package.json", "cargo.toml",
        "go.mod", "gemfile", "makefile", "dockerfile", ".gitignore", ".gitattributes",
        "requirements.txt", "tsconfig.json", "_config.yml",
    }
)

ARCH_TOWER = "tower"
ARCH_SLAB = "slab"
ARCH_WAREHOUSE = "warehouse"
ARCH_SILO = "silo"
ARCH_MONUMENT = "monument"
ARCH_TOWN_HALL = "town_hall"
ARCH_PARK = "park"
ARCH_RUIN = "ruin"


def is_test_path(rel: str) -> bool:
    parts = rel.split("/")
    if any(part in TEST_DIR_SEGMENTS for part in parts[:-1]):
        return True
    return any(pattern.match(parts[-1]) for pattern in TEST_FILE_PATTERNS)


def is_doc_path(rel: str) -> bool:
    return rel.rsplit("/", 1)[-1].lower() in DOC_NAMES


def is_noise_path(rel: str) -> bool:
    """True for files that only exist because ``--include-noise`` was used."""
    from .walk import NOISE_DIRS, NOISE_FILES

    parts = rel.split("/")
    if any(part in NOISE_DIRS for part in parts[:-1]):
        return True
    if parts[-1] in NOISE_FILES:
        return True
    return parts[-1].endswith((".pyc", ".pyo"))


# --------------------------------------------------------------------------
# Sizing: the legend, in numbers
# --------------------------------------------------------------------------

def height_for(language: str, logical_loc: int, rows: int | None, is_binary: bool) -> float:
    """Building height in metres, from logical source or from data rows."""
    if is_binary:
        return 0.0
    if rows is not None:
        # Silos: 1,565 rows is a tall silo; 2 rows is a squat one.
        return 4.0 + 1.10 * math.sqrt(max(0, rows))
    if language == "markdown":
        # Documentation is low-rise: a README is not a skyscraper.
        return 3.0 + 1.30 * math.sqrt(max(0, logical_loc))
    return 6.0 + 3.20 * math.sqrt(max(0, logical_loc))


def footprint_for(
    size: int,
    logical_loc: int = 0,
    floor_lines: list[int] | None = None,
    physical_lines: int = 0,
) -> tuple[float, float]:
    """Plan dimensions in metres: width and depth, which are not the same number.

    Bytes on disk alone made every building a square, and a square whose side
    barely moved: file sizes cluster hard, so a repository came out as a field
    of identical plots.  The floor plan is the better question anyway -- a
    building's footprint should say how much code stands on one floor.

    * **Area** is the average logical lines per floor.  A module of twenty
      hundred-line functions has deep floor plates; one of two hundred
      five-line functions has small ones, even when the two files are the same
      size on disk and therefore exactly as tall.
    * **Aspect** is how evenly the file divides up -- its longest section
      against its average one.  Code whose functions are all about the same
      length is a squarish block; a file with one enormous function among small
      ones is a slab.  So a square building now means something: evenly divided
      code.

    Section lengths are measured from where the floors *start*, not from
    ``Floor.loc``: several parsers use that field for the source slice an
    interior should show, and a markdown heading's slice is deliberately one
    line.  Gaps between successive floors are the same measurement in every
    language, which is what a legend entry needs to be.

    Files with no floor plan at all -- data blobs, lock files, anything the
    parser could not read -- fall back to bytes on disk for area, and to their
    own mean line length for aspect: a file of long lines is a wide building.
    """
    lines = sorted(n for n in (floor_lines or []) if n > 0)

    if lines and logical_loc > 0:
        plate = logical_loc / len(lines)
        side = 3.5 + 1.45 * math.sqrt(plate)
        end = max(physical_lines, lines[-1]) + 1
        spans = [b - a for a, b in zip(lines, lines[1:] + [end]) if b > a]
        mean = sum(spans) / len(spans) if spans else 0.0
        spread = max(spans) / mean if mean > 0 else 1.0
    else:
        side = 4.0 + 0.055 * math.sqrt(max(0, size))
        # Mean bytes per line against a plain 45-character line.
        mean_line = size / physical_lines if physical_lines > 0 else 45.0
        spread = (mean_line / 45.0) ** 2

    side = min(40.0, max(3.5, side))
    # The fourth root keeps a very lopsided file from becoming a wall, and the
    # square root on each half keeps width * depth equal to the area the plate
    # asked for -- so the aspect never smuggles in extra floor space.
    ratio = math.sqrt(min(2.6, max(0.5, math.sqrt(math.sqrt(max(1e-6, spread))))))
    # Clamp the dimensions themselves, not just the area's side, so no single
    # file can put a wall across its district.
    clamp = lambda metres: min(46.0, max(2.5, metres))
    return clamp(side * ratio), clamp(side / ratio)


def archetype_for(
    language: str,
    logical_loc: int,
    floors: int,
    rows: int | None,
    is_binary: bool,
    is_test: bool,
    is_doc: bool,
    is_ruin: bool,
    height: float,
) -> str:
    """Pick a silhouette for the kinds of building that are not size-ranked.

    Ordinary code is left as ``ARCH_PENDING`` and resolved later against the
    repo's own height distribution -- see :func:`assign_code_archetypes`.
    """
    if is_ruin:
        return ARCH_RUIN
    if is_test:
        return ARCH_PARK
    if is_binary:
        return ARCH_MONUMENT
    if rows is not None:
        return ARCH_SILO
    if is_doc and language == "markdown":
        return ARCH_TOWN_HALL
    if language == "markdown":
        return ARCH_WAREHOUSE
    return ARCH_PENDING


ARCH_PENDING = "pending"

# Relative split for ordinary code buildings, by height rank inside one repo.
TOWER_PERCENTILE = 0.75
SLAB_PERCENTILE = 0.40
MIN_FOR_RELATIVE_SPLIT = 8


def assign_code_archetypes(records: list[FileMetrics]) -> None:
    """Assign tower / slab / warehouse by rank, not by absolute metres.

    Absolute thresholds do not travel between repos: the small reference repo
    tops out at 52 m and the large one at 125 m, so a fixed 70 m "tower" line
    gives one city no towers at all and the other 225 near-identical ones.
    Ranking inside the repo gives every city a readable skyline, and it is the
    honest reading of "the tallest things here".
    """
    pending = [r for r in records if r.archetype == ARCH_PENDING]
    if not pending:
        return

    if len(pending) < MIN_FOR_RELATIVE_SPLIT:
        for record in pending:
            if record.height >= 70.0 or len(record.floors) >= 25:
                record.archetype = ARCH_TOWER
            elif record.height >= 34.0 or len(record.floors) >= 6:
                record.archetype = ARCH_SLAB
            else:
                record.archetype = ARCH_WAREHOUSE
        return

    ordered = sorted(pending, key=lambda r: (r.height, r.logical_loc))
    tower_cut = ordered[int(len(ordered) * TOWER_PERCENTILE) - 1].height if len(ordered) else 0.0
    slab_cut = ordered[int(len(ordered) * SLAB_PERCENTILE) - 1].height if len(ordered) else 0.0

    for record in ordered:
        if record.height >= tower_cut:
            record.archetype = ARCH_TOWER
        elif record.height >= slab_cut:
            record.archetype = ARCH_SLAB
        else:
            record.archetype = ARCH_WAREHOUSE


# --------------------------------------------------------------------------
# Records
# --------------------------------------------------------------------------


@dataclass
class FileMetrics:
    rel: str
    name: str
    abspath: str
    district: str
    language: str
    size: int
    logical_loc: int
    physical_lines: int
    floors: list[Floor]
    rows: int | None
    is_binary: bool
    is_test: bool
    is_doc: bool
    is_config: bool
    is_ruin: bool
    archetype: str
    height: float
    footprint: float  # the plot's mean side, kept for the legend and for stats
    doc_ratio: float
    lit_windows: float | None
    confidence: dict[str, str] = field(default_factory=dict)
    parse_confidence: str = "high"
    parse_error: str = ""
    # git-derived
    commits: int = 0
    churn: int = 0
    last_ts: float = 0.0
    last_author: str = ""
    last_message: str = ""
    primary_author: str = ""
    ownership_share: float = 0.0
    authors: dict[str, int] = field(default_factory=dict)
    recency_days: float = 0.0
    # Plan dimensions, which are not each other; see footprint_for. Defaulted so
    # a record built without them still lays out, as a square, off `footprint`.
    footprint_w: float = 0.0
    footprint_d: float = 0.0

    @property
    def weight(self) -> float:
        """District-area weight: content, never bytes on disk."""
        if self.rows is not None:
            return max(1.0, math.sqrt(max(1, self.rows)) * 6.0)
        if self.is_binary:
            return max(1.0, math.log2(max(2, self.size)) * 1.5)
        return max(1.0, float(self.logical_loc or 1))


@dataclass
class RepoFlags:
    """Which legend entries are meaningful for this repo."""

    authorship: bool = False
    recency: bool = False
    churn: bool = False
    coupling: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "authorship": self.authorship,
            "recency": self.recency,
            "churn": self.churn,
            "coupling": self.coupling,
            "notes": list(self.notes),
        }


@dataclass
class RepoAnalysis:
    root: str
    files: list[FileMetrics] = field(default_factory=list)
    flags: RepoFlags = field(default_factory=RepoFlags)
    walk_source: str = ""
    noise_excluded: int = 0
    truncated: bool = False
    git: GitIndex | None = None
    languages: dict[str, int] = field(default_factory=dict)
    total_bytes: int = 0

    @property
    def total_logical_loc(self) -> int:
        return sum(f.logical_loc for f in self.files if f.rows is None and not f.is_binary)

    @property
    def documented_files(self) -> int:
        return sum(1 for f in self.files if f.doc_ratio >= 0.1)


def compute_flags(git: GitIndex) -> RepoFlags:
    """Turn raw git numbers into explicit, testable confidence decisions."""
    flags = RepoFlags()
    if not git.available:
        flags.notes.append("No git history available - authorship, churn, recency and bridges are all disabled.")
        return flags

    flags.authorship = git.author_count >= 2
    flags.recency = git.active_dates >= 3
    flags.churn = git.commit_count >= 5 and git.max_eligible_commit_files >= 2
    flags.coupling = git.eligible_commits >= 2 and len(git.coupling) > 0

    if not flags.authorship:
        flags.notes.append("Single author - mayor system disabled.")
    if not flags.recency:
        flags.notes.append("Fewer than three active commit dates - weathering is uniform.")
    if not flags.churn:
        flags.notes.append("Too little churn history - cranes disabled.")
    if not flags.coupling:
        if git.bulk_commits:
            flags.notes.append(
                f"Co-change coupling disabled: {git.bulk_commits} bulk commit(s) touched too many files to imply a relationship."
            )
        else:
            flags.notes.append("Co-change coupling disabled - too few commits.")
    return flags


def analyze(
    root: str,
    entries: list[FileEntry],
    git: GitIndex,
    include_noise: bool = False,
) -> RepoAnalysis:
    """Parse every file and assemble the metric set."""
    analysis = RepoAnalysis(root=root, git=git)
    now = None

    for entry in entries:
        result = parse_pkg.parse_file(entry.abs, entry.name, entry.is_binary)
        language = result.language

        is_test = is_test_path(entry.rel)
        is_doc = is_doc_path(entry.rel)
        is_config = entry.name.lower() in CONFIG_NAMES
        is_ruin = include_noise and is_noise_path(entry.rel)

        floors = result.floors
        height = height_for(language, result.logical_loc, result.rows, entry.is_binary)
        logical = result.rows if result.rows is not None else result.logical_loc
        archetype = archetype_for(
            language, result.logical_loc, len(floors), result.rows,
            entry.is_binary, is_test, is_doc, is_ruin, height,
        )
        if archetype == ARCH_PARK:
            # Parks are flat: test code is a green tile, not a tower.
            height = max(2.0, height * 0.25)
        if archetype == ARCH_MONUMENT:
            height = 12.0 + min(28.0, math.log2(max(2, entry.size)) * 1.6)

        denom = max(1, result.logical_loc)
        doc_ratio = min(1.0, result.doc_lines / denom)
        lit = None if (entry.is_binary or result.rows is not None) else doc_ratio

        _footprint_w, _footprint_d = footprint_for(
            entry.size, logical, [floor.line for floor in floors], result.physical_lines
        )
        _footprint = math.sqrt(_footprint_w * _footprint_d)

        record = FileMetrics(
            rel=entry.rel,
            name=entry.name,
            abspath=entry.abs,
            district="",
            language=language,
            size=entry.size,
            logical_loc=logical,
            physical_lines=result.physical_lines,
            floors=floors,
            rows=result.rows,
            is_binary=entry.is_binary,
            is_test=is_test,
            is_doc=is_doc,
            is_config=is_config,
            is_ruin=is_ruin,
            archetype=archetype,
            height=height,
            footprint=_footprint,
            footprint_w=_footprint_w,
            footprint_d=_footprint_d,
            doc_ratio=doc_ratio,
            lit_windows=lit,
            parse_confidence=result.confidence,
            parse_error=result.parse_error,
            confidence={"size": "high", "symbols": result.confidence, "docs": result.confidence},
        )

        file_git = git.files.get(entry.rel)
        if file_git is not None:
            record.commits = file_git.commits
            record.churn = file_git.churn
            record.last_ts = file_git.last_ts
            record.last_author = file_git.last_author
            record.last_message = file_git.last_message
            record.primary_author = file_git.primary_author
            record.ownership_share = file_git.ownership_share()
            record.authors = dict(file_git.authors)
        else:
            record.confidence["authorship"] = "unknown"

        analysis.files.append(record)
        analysis.languages[language] = analysis.languages.get(language, 0) + 1
        analysis.total_bytes += entry.size

    analysis.flags = compute_flags(git)
    assign_code_archetypes(analysis.files)
    if git.available:
        for record in analysis.files:
            record.recency_days = days_since(record.last_ts, now) if record.last_ts else 0.0
    return analysis
