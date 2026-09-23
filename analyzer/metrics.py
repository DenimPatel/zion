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
    # Time signals (S1/S4 in docs/VISUALIZATION_ROADMAP.md). `age_days` is
    # relative to the repo's own newest commit, never wall-clock time -- an
    # old clone still shows its own newest files as new, and the number does
    # not change between two test runs on two different days.
    first_ts: float = 0.0
    age_days: float = 0.0
    is_new: bool = False
    era: str = "mid"  # old | mid | new, a tertile of age_days across the repo
    activity: list[int] = field(default_factory=list)
    recent_churn: float = 0.0
    heat: float = 0.0  # percentile rank of recent_churn across the repo, 0..1
    # Downtown (S8 in docs/VISUALIZATION_ROADMAP.md).
    raw_imports: list[str] = field(default_factory=list)  # as the parser saw them, unresolved
    import_in_degree: int = 0  # how many other files resolve an import to this one
    centrality: float = 0.0  # composite percentile rank, 0..1
    downtown: bool = False  # top slice of centrality
    sole_tenant: bool = False  # bus-factor-1: one author, most of the lines (S12)
    # Architect's signals, filled by analyzer/health.py.
    first_author: str = ""
    imports_resolved: list[str] = field(default_factory=list)  # rel paths this file imports
    author_count: int = 0
    bus_factor: int = 0
    owner_away_days: float = 0.0
    owner_inactive: bool = False
    knowledge_risk: bool = False
    size_pct: float = 0.0
    is_oversized: bool = False
    longest_floor: tuple[str, int] | None = None
    max_complexity: int = 0
    hotspot: float = 0.0
    hotspot_rank: int = 0
    is_hotspot: bool = False
    is_orphan: bool = False
    cycle_id: int = 0
    cycle_size: int = 0
    # Dependency structure (analyzer/architecture.py), filled once districts exist.
    import_violations: list[str] = field(default_factory=list)  # imports that break a layering rule
    is_violation: bool = False
    file_instability: float = -1.0  # fan-out / (fan-in + fan-out); -1 with no imports either way
    # Ownership (analyzer/owners.py).
    author_shares: list[tuple[str, float]] = field(default_factory=list)
    expert_scores: dict[str, float] = field(default_factory=dict)
    experts: list[tuple[str, float]] = field(default_factory=list)
    author_buckets: dict[str, set[int]] = field(default_factory=dict)
    declared_owners: list[str] = field(default_factory=list)
    owner_drift: bool = False
    is_unowned: bool = False
    # Tests and complexity (analyzer/testmap.py).
    tested_by: list[str] = field(default_factory=list)
    is_tested: bool = False
    is_untested: bool = False
    untested_risk: bool = False
    is_braced: bool = False
    brace_complexity: int = 0  # the most decision points in one function or method
    # Change since a baseline (analyzer/history.py).
    delta: str = ""  # "" | "added" | "grown" | "shrunk"
    loc_delta: int = 0
    became: list[str] = field(default_factory=list)  # signals gained since the baseline

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
    age: bool = False
    centrality: bool = False
    # Architect's signals (analyzer/health.py), each gated like the data under it.
    hotspots: bool = False
    knowledge: bool = False
    imports: bool = False
    # Next layer (architecture.py, owners.py, testmap.py, history.py).
    layering: bool = False
    codeowners: bool = False
    tests: bool = False
    complexity: bool = False
    delta: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "authorship": self.authorship,
            "recency": self.recency,
            "churn": self.churn,
            "coupling": self.coupling,
            "age": self.age,
            "centrality": self.centrality,
            "hotspots": self.hotspots,
            "knowledge": self.knowledge,
            "imports": self.imports,
            "layering": self.layering,
            "codeowners": self.codeowners,
            "tests": self.tests,
            "complexity": self.complexity,
            "delta": self.delta,
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
    cycles: list[list[str]] = field(default_factory=list)  # import cycles, largest first
    architecture: object = None  # architecture.Architecture, once a layout exists
    codeowners_path: str = ""
    delta: dict | None = None  # history.apply_delta's result, when a baseline exists

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
    # At least two distinct birth days among tracked files: a repo where every
    # file was added in the same commit has nothing for "new" to mean.
    birth_days = {int(f.first_ts // 86400) for f in git.files.values() if f.first_ts}
    flags.age = len(birth_days) >= 2

    if not flags.authorship:
        flags.notes.append("Single author - mayor system disabled.")
    if not flags.recency:
        flags.notes.append("Fewer than three active commit dates - weathering is uniform.")
    if not flags.churn:
        flags.notes.append("Too little churn history - cranes disabled.")
    if not flags.age:
        flags.notes.append("All tracked files share one birth date - new-construction scaffolding disabled.")
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
    # Weathering is measured back from the repo's own newest commit, like age
    # and heat: the same clone must build the same city on any day.
    now = git.last_ts if git.available and git.last_ts else None

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

        record.raw_imports = result.imports

        file_git = git.files.get(entry.rel)
        if file_git is not None:
            record.commits = file_git.commits
            record.churn = file_git.churn
            record.last_ts = file_git.last_ts
            record.last_author = file_git.last_author
            record.first_author = file_git.first_author
            record.last_message = file_git.last_message
            record.primary_author = file_git.primary_author
            record.ownership_share = file_git.ownership_share()
            record.authors = dict(file_git.authors)
            record.first_ts = file_git.first_ts
            record.activity = list(file_git.activity)
            record.recent_churn = file_git.recent_churn
            record.author_buckets = {a: set(b) for a, b in file_git.author_buckets.items()}
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
        _finalize_time_signals(analysis, git)
    _finalize_downtown(analysis, git)
    if analysis.flags.authorship:
        # Bus-factor-1 (S12): one author owns almost all of a file's lines, in
        # a repo where "one author" is not just everyone -- only meaningful
        # once RepoFlags.authorship already says ownership means something.
        for record in analysis.files:
            record.sole_tenant = record.ownership_share >= SOLE_TENANT_SHARE and record.commits >= SOLE_TENANT_MIN_COMMITS
    from .health import finalize_health
    from .owners import finalize_owners
    from .testmap import finalize_tests

    finalize_health(analysis, git)
    finalize_owners(analysis, git)
    finalize_tests(analysis)
    return analysis


SOLE_TENANT_SHARE = 0.9
SOLE_TENANT_MIN_COMMITS = 3


# New-construction window: the newest slice of the repo's own lifetime, floored
# at 30 days so a young repo does not call everything new. See S2 in
# docs/VISUALIZATION_ROADMAP.md.
NEW_WINDOW_FRACTION = 0.10
NEW_WINDOW_MIN_DAYS = 30.0


def _finalize_time_signals(analysis: "RepoAnalysis", git: GitIndex) -> None:
    """Age tertiles, the new-construction window, and the heat percentile.

    All three are computed once, over every file, so each is relative to
    *this* repo rather than an arbitrary fixed threshold -- the same
    philosophy `choose_depth` already applies to district count. Age (birth
    date spread) and heat (recent churn) are independent signals with
    independent degeneration rules, so each is gated on its own flag.
    """
    if analysis.flags.age:
        repo_lifetime_days = max(0.0, (git.last_ts - git.first_ts) / 86400.0)
        window = max(NEW_WINDOW_MIN_DAYS, repo_lifetime_days * NEW_WINDOW_FRACTION)

        dated = [f for f in analysis.files if f.first_ts]
        for record in dated:
            record.age_days = max(0.0, (git.last_ts - record.first_ts) / 86400.0)
            record.is_new = record.age_days <= window

        # Era tertiles: oldest third / middle third / newest third by age, not
        # a fixed day count, so the split means something in a two-week-old
        # repo and a ten-year-old one alike.
        by_age = sorted(dated, key=lambda f: f.age_days)
        third = max(1, len(by_age) // 3)
        for index, record in enumerate(by_age):
            if index < third:
                record.era = "new"
            elif index < 2 * third:
                record.era = "mid"
            else:
                record.era = "old"

    # Heat: percentile rank of recent_churn, gated on the same degeneration
    # rule cranes already use -- not on `flags.age`, since a repo can have
    # meaningful churn history with every file born on the same day (a single
    # initial commit, then years of edits).
    if analysis.flags.churn:
        churny = sorted((f for f in analysis.files if f.recent_churn > 0), key=lambda f: f.recent_churn)
        total = len(churny)
        for rank, record in enumerate(churny):
            record.heat = (rank + 1) / total if total else 0.0


# --------------------------------------------------------------------------
# Downtown (S8): centrality from co-change degree, import in-degree, heat and
# ownership breadth.
# --------------------------------------------------------------------------

DOWNTOWN_FRACTION = 0.05
DOWNTOWN_MIN_FILES = 3
CBD_DENSITY_MULTIPLE = 2.0


def _python_module_map(files: list[FileMetrics]) -> dict[str, str]:
    """Dotted module path -> rel path, for every Python file."""
    mapping: dict[str, str] = {}
    for record in files:
        if record.language != "python" or not record.rel.endswith(".py"):
            continue
        rel = record.rel
        if rel.endswith("/__init__.py"):
            dotted = rel[: -len("/__init__.py")].replace("/", ".")
        else:
            dotted = rel[:-3].replace("/", ".")
        mapping[dotted] = rel
    return mapping


def _resolve_python_import(spec: str, importer_rel: str, module_map: dict[str, str]) -> str | None:
    """Best-effort: a dotted module or a name pulled from one, or a relative
    import resolved against the importing file's own package directory."""
    if spec.startswith("."):
        level = len(spec) - len(spec.lstrip("."))
        remainder = spec[level:]
        base_parts = importer_rel.replace("\\", "/").split("/")[:-1]  # drop the filename
        # Level 1 (`from . import x`) means "this package"; each extra dot
        # climbs one more directory, matching Python's own semantics.
        climb = max(0, level - 1)
        base_parts = base_parts[: len(base_parts) - climb] if climb else base_parts
        candidate = ".".join(base_parts + (remainder.split(".") if remainder else []))
    else:
        candidate = spec

    parts = candidate.split(".")
    for i in range(len(parts), 0, -1):
        probe = ".".join(parts[:i])
        if probe in module_map and module_map[probe] != importer_rel:
            return module_map[probe]
    return None


_RELATIVE_PATH_SUFFIXES = ("", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.ts", "/index.jsx", "/index.tsx")


def _resolve_relative_path_import(spec: str, importer_rel: str, path_set: set[str]) -> str | None:
    """A `./foo` or `../bar/baz` specifier, resolved against the importing
    file's own directory and tried against a small set of common extensions
    -- there is no module system to consult, only the file tree itself."""
    import posixpath

    base_dir = posixpath.dirname(importer_rel)
    joined = posixpath.normpath(posixpath.join(base_dir, spec))
    for suffix in _RELATIVE_PATH_SUFFIXES:
        candidate = joined + suffix
        if candidate in path_set and candidate != importer_rel:
            return candidate
    return None


def _percentile_ranks(values: dict[str, float]) -> dict[str, float]:
    """Rank-based percentile, 0..1, ties broken by stable sort order.

    Rank rather than raw value, so one enormous outlier (a util file imported
    everywhere) does not compress every other file's score toward zero.
    """
    positive = sorted((key for key, v in values.items() if v > 0), key=lambda k: values[k])
    total = len(positive)
    return {key: (rank + 1) / total for rank, key in enumerate(positive)}


def _finalize_downtown(analysis: "RepoAnalysis", git: GitIndex) -> None:
    """Score every file's centrality and mark the top slice as downtown.

    Weights are dropped and the rest renormalised when a component has
    nothing to say -- a single-author repo still gets a downtown from
    coupling and imports alone, just not from ownership breadth.
    """
    files = analysis.files
    if not files:
        return

    module_map = _python_module_map(files)
    path_set = {f.rel for f in files}

    in_degree: dict[str, int] = {}
    edge_count = 0
    for record in files:
        for spec in record.raw_imports:
            target = (
                _resolve_python_import(spec, record.rel, module_map)
                if record.language == "python"
                else _resolve_relative_path_import(spec, record.rel, path_set)
            )
            if target:
                in_degree[target] = in_degree.get(target, 0) + 1
                edge_count += 1
                if target not in record.imports_resolved:
                    record.imports_resolved.append(target)
    for record in files:
        record.import_in_degree = in_degree.get(record.rel, 0)

    coupling_degree: dict[str, int] = {}
    if analysis.flags.coupling and git.coupling:
        for path_a, path_b in git.coupling:
            coupling_degree[path_a] = coupling_degree.get(path_a, 0) + 1
            coupling_degree[path_b] = coupling_degree.get(path_b, 0) + 1

    components: list[tuple[float, dict[str, float]]] = []
    if coupling_degree:
        components.append((0.35, _percentile_ranks({f.rel: coupling_degree.get(f.rel, 0) for f in files})))
    if edge_count:
        components.append((0.35, _percentile_ranks({f.rel: float(in_degree.get(f.rel, 0)) for f in files})))
    if analysis.flags.churn:
        components.append((0.20, _percentile_ranks({f.rel: f.heat for f in files})))
    if analysis.flags.authorship:
        components.append((0.10, _percentile_ranks({f.rel: float(len(f.authors)) for f in files})))

    analysis.flags.centrality = bool(coupling_degree) or bool(edge_count)
    if not analysis.flags.centrality:
        analysis.flags.notes.append("No coupling data or resolvable imports - downtown disabled.")
        return

    weight_total = sum(w for w, _ in components)
    for record in files:
        record.centrality = sum(w * ranks.get(record.rel, 0.0) for w, ranks in components) / weight_total

    ranked = sorted(files, key=lambda f: -f.centrality)
    cutoff = max(DOWNTOWN_MIN_FILES, round(len(files) * DOWNTOWN_FRACTION))
    for record in ranked[:cutoff]:
        if record.centrality > 0:
            record.downtown = True
