"""Emit the city: manifest, district chunks, floor detail and the string table.

Everything human-readable -- paths, names, authors, docstrings, stats labels --
lives in the string table and is referenced by integer index.  That is what makes
``--encrypt`` a clean swap rather than a re-serialization: the geometry in
``city.json`` and ``d/*.json`` is byte-identical locked or unlocked, and only
``strings.bin`` plus the ``f/*`` payloads change.

Source bodies are written to ``f/<id>.src`` as raw bytes with byte offsets
recorded in ``f/<id>.json``.  Interiors carry full source by explicit choice, and
a 10.8 MB HTML corpus would inflate noticeably if every page were JSON-escaped.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from . import parse as parse_pkg
from .health import review as health_review
from .layout import ROAD_NAMES, ROOT_DISTRICT, CityLayout, DistrictLayout, build_layout
from .metrics import FileMetrics, RepoAnalysis

FORMAT = "zion-city"
VERSION = 1
STRING_MAGIC = b"ZIONSTR1"

# Legend entries, in display order: (id, label, unit, group, description).
# `enabled` is decided by RepoFlags. The label is the one-line encoding; the
# description is the longer "what it means and the exact rule" the City Guide
# shows when a row is expanded. Both are schema, not repository data.
LEGEND_SPEC = [
    ("height", "Logical source lines -> building height", "loc", "Size & shape",
     "Height grows with the square root of logical lines -- code, not blank lines or comments, and "
     "never bytes on disk. Data files use rows instead. A tower is a file with a lot of real code."),
    ("footprint", "Lines per floor -> footprint; even floors -> square plan", "plate", "Size & shape",
     "The ground a building covers grows with the average length of its definitions. Long functions give "
     "a wide, heavy plan; many short ones give a slender tower. Evenly sized definitions give a square plan, "
     "uneven ones a long slab."),
    ("floors", "Functions, classes, headings, cells -> floors", "count", "Size & shape",
     "Every top-level function, class, markdown heading or notebook cell is one floor, and each floor is one "
     "row of windows. A building with 2 floors has 2 top-level definitions. Walk in to see them by name."),
    ("lit_windows", "Docstring + comment ratio -> lit windows", "ratio", "Size & shape",
     "The share of lit windows is the share of documentation: docstrings, comments and prose. A dark facade "
     "is undocumented code."),
    ("district_area", "Folder content weight -> district area", "weight", "Ground",
     "Each folder at the chosen depth is a district. Its ground is sized by the code it holds, but never "
     "smaller than its buildings need."),
    ("roads", "Folder tree distance -> road class", "class", "Ground",
     "Roads get narrower as you go deeper into the folder tree. Highways separate top-level folders and ring "
     "City Hall, avenues split their sub-folders, then streets, then alleys. A wide road between two "
     "neighbourhoods means they are far apart in the folder tree."),
    ("regions", "Nested folders -> raised plinths", "level", "Ground",
     "Every folder that splits into several neighbourhoods stands on its own plinth, one step higher per "
     "level. Folders with a single sub-folder pass straight through. Click the plinth's edge to inspect the "
     "folder."),
    ("new_construction", "First commit within the newest activity window -> scaffolding", "days", "Construction & time",
     "Scaffolding marks a building still going up: the file's first commit is within the newest 10% of the "
     "repository's lifetime (at least 30 days)."),
    ("churn", "Top 10% of recent change -> cranes", "commits", "Construction & time",
     "A crane stands on files in the top 10% of recent, decay-weighted change. They are active construction "
     "sites."),
    ("heat", "Recent, decay-weighted churn -> rooftop beacons, cranes", "percentile", "Construction & time",
     "A rooftop beacon grades recent activity below the crane cut-off: grey is warm, amber busy, red very "
     "busy. A commit from a month ago counts half as much as one today."),
    ("weathering", "Days since last commit -> weathering", "days", "Construction & time",
     "Facades weather with time since the last commit, measured back from the repository's newest commit. "
     "Clean is fresh; grimy has not been touched in two years or more."),
    ("author_tint", "Dominant author -> building tint and Mayor", "authors", "People",
     "The building takes the colour of the author who added most of its lines. The author with the most lines "
     "in a district is its Mayor."),
    ("sole_tenant", "One author owns ≥ 90% of a file's lines -> a corner flag", "bool", "People",
     "A corner flag means bus factor 1: a single author wrote at least 90% of the file across 3+ commits. The "
     "flag turns red when that author has not committed anywhere in six months."),
    ("town_hall", "README in folder -> Town Hall", "bool", "Civic",
     "A folder with its own README gets a Town Hall. A neighbourhood without one has no public notice board."),
    ("parks", "Test files -> parks", "bool", "Civic",
     "Test code is green space: low parks, not towers."),
    ("silos", "Data files -> silos (height = rows)", "rows", "Civic",
     "CSV/TSV/JSONL and other data files are silos. Height is rows, streamed and counted, never loaded."),
    ("monuments", "Binary artefacts -> monuments", "bool", "Civic",
     "Images, archives and other binaries are monuments. They have no floors because there is no source to "
     "read."),
    ("downtown", "Co-change degree + import in-degree + heat + author count -> downtown towers", "percentile", "Civic",
     "The most central 5% of files, by how many files change with them, import them, how hot they are and "
     "how many people touch them. They get glass and an antenna. Changes here ripple furthest."),
    ("skybridges", "Files changed in one commit -> co-change rings around the selected building", "pairs",
     "Civic",
     "Files that keep changing in the same commits are coupled even if they never import each other. Select a "
     "building and the files it changes with are ringed in teal on the ground; the pairs are also listed in its "
     "report, with pairs that cross district lines called out as hidden coupling."),
    ("hotspots", "Change frequency x size -> hazard barriers", "rank", "Health",
     "Striped barriers ring a hotspot: a file in the top 5% by commit frequency times size. Large and "
     "constantly changing is where refactoring pays back first."),
    ("oversized", "Top 5% by lines and 400+ lines -> steel buttresses", "loc", "Health",
     "Buttresses brace a building too heavy for its frame: in the top 5% of the repository by logical lines "
     "and at least 400 of them. Its report names the longest definition, the first thing to split out."),
    ("orphans", "No importers + untouched 6 months -> boarded up", "bool", "Health",
     "Boarded windows and a vacancy sign: nothing in the repository imports this file, it is not an entry "
     "point, and it has not changed in six months. Import resolution is best-effort (Python, relative JS/TS), "
     "so treat this as a question, not a verdict."),
    ("cycles", "Import cycle -> matching rooftop pennants", "size", "Health",
     "Files that import each other in a loop fly pennants of the same colour. A cycle cannot be built, tested "
     "or understood one piece at a time. Break one edge."),
    ("knowledge", "Main owner inactive 6+ months -> red corner flag", "bool", "Health",
     "The author who wrote most of this file has not committed anywhere in the repository for six months. "
     "Whoever changes it next is on their own. Pair up or document it."),
    ("untested", "Risky file with no linked test -> traffic cones", "bool", "Health",
     "Traffic cones stand around a hotspot, oversized or downtown file that no test is linked to, by import or by "
     "name (test_layout.py, layout.test.ts, LayoutTest.java). That is where a regression costs the most and is "
     "caught the least. Linking is best-effort: a test reached another way is not seen."),
    ("complexity", "15+ decision points in one definition -> cross-bracing", "points", "Health",
     "Steel cross-bracing on the facade: one definition in the file has at least 15 decision points (if, for, "
     "while, try, boolean operators). Exact for Python, heuristic elsewhere. Hard to test every path; split it."),
    ("imports", "Resolved imports -> utility lines from the selected building", "edges", "Structure",
     "Select a building and its dependencies are drawn as utility lines: blue to the files it imports, amber from "
     "the files that import it, red for an import that breaks the layering. Only the selection is drawn, never the "
     "whole graph, so a line can always be followed to its end. Resolution is best-effort (Python, relative JS/TS)."),
    ("instability", "Share of imports that point outward -> instability lens", "ratio", "Structure",
     "Instability is fan-out / (fan-in + fan-out): 0 is a foundation many files lean on and that should change "
     "rarely, 1 is a leaf nothing depends on and that can change freely. The Filter tab's instability lens paints "
     "it per file; each folder's own value (Robert C. Martin's Ca / Ce) is in its inspector."),
    ("violations", "Import against the layering -> red no-entry sign", "edges", "Structure",
     "A red no-entry sign stands at a file with an import that points the wrong way. With a .zion/rules.json in "
     "the repository the layers are yours; without one, a folder pair that imports both ways is a folder-level "
     "cycle, and the thinner direction is the edge to break."),
    ("district_coupling", "Co-change between folders -> links from the selected district", "pairs", "Structure",
     "Select a district and the folders it keeps changing together with are joined to it by arcs, thicker for "
     "more shared commits. Hidden coupling between parts: no import says so, the history does."),
    ("codeowners", "CODEOWNERS names someone else -> an owner notice", "bool", "People",
     "A purple notice board: the individuals CODEOWNERS names for this file commit to the repository but wrote "
     "almost none of it. The declared owner has drifted from the real one. Teams cannot be checked from history "
     "and are never called drifted."),
    ("experts", "Recency-weighted authorship -> who to ask", "authors", "People",
     "The people to ask about a file or folder: authors ranked by the lines they added, halved for every six "
     "months since they last touched it. Listed in the inspector, not drawn."),
    ("delta", "Changed since the baseline -> survey stakes", "files", "Construction & time",
     "A survey stake marks a file that changed since the baseline -- the previous build into this directory, or "
     "the revision given to --compare: green for added, blue for grown, grey for shrunk by 10% or more. The "
     "Health tab lists what became a hotspot, joined a cycle or broke a rule since."),
    ("defects", "High share of fix commits -> red warning lamp", "ratio", "Health",
     "A red warning lamp on the roof: an unusually large share of this file's commits read as fixes (\"fix\", "
     "\"bug\", \"hotfix\", \"revert\", \"closes #12\"). Top decile of the repository, at least five commits and two "
     "fixes. Bugs cluster; this is where the next one is most likely."),
    ("hubs", "Top 10% of both importers and imports -> steel collar", "edges", "Structure",
     "A steel collar rings a hub: a file in the top tenth of the repository both for how many files import it and "
     "for how many it imports. A change there ripples up and down the import graph at once. Split it along its "
     "callers."),
    ("debt", "TODO / FIXME / HACK comments -> yellow tags", "count", "Health",
     "Yellow tags hang on the facade of a file whose comments carry TODO, FIXME, HACK or XXX markers, one per "
     "marker up to five. The report lists each one with its line. Debt that was written down."),
    ("trend", "Last quarter's commits vs the quarter before -> trend lens", "commits", "Construction & time",
     "Rising, steady or cooling: the commits in the last three months against the three before. A hotspot that "
     "is rising is the refactor that gets more expensive every week. Filter tab: colour by trend, or is:rising."),
    ("hidden_coupling", "Changed together, no import -> dashed arcs from the selected building", "pairs",
     "Structure",
     "Two files in different folders that change in the same commits at least half the time although neither "
     "imports the other. The dependency is real -- a format, a protocol, a copy -- but the code does not say "
     "so. Select a building to see its partners as dashed violet arcs."),
    ("clones", "Copied code -> twin links from the selected building", "pairs", "Structure",
     "Two files that share a long run of near-identical code, found by fingerprinting the normalised source "
     "(renamed variables and reformatting still match). A fix made in one is easily missed in the other. "
     "Select a building to see its twins linked in cyan."),
    ("abstractness", "Abstract share vs instability -> the main sequence", "ratio", "Structure",
     "For each folder, A is the share of its type definitions that are abstract (interfaces, ABCs, protocols) and "
     "D = |A + I - 1| its distance from the main sequence. Stable and concrete is the zone of pain: everything "
     "leans on it and nothing in it bends. City Hall plots every folder; the Filter tab colours by it."),
    ("teams", "Recent authors per folder -> coordination cost", "authors", "People",
     "How many people worked in a folder in the last three months, how much of its work also had to touch "
     "another folder in the same commit, and whether anyone leads it. Many recent authors and nobody above 40% "
     "is \"many cooks\". Shown in the folder's inspector."),
    ("timeline", "First commit dates -> the History slider", "days", "Construction & time",
     "Drag the History slider, or press play, and the city is rebuilt as it stood on that day: files appear on the "
     "day of their first commit and burn with that month's commits."),
]


class StringTable:
    """Deduplicating string interning with stable integer indices."""

    def __init__(self) -> None:
        self._strings: list[str] = []
        self._index: dict[str, int] = {}

    def add(self, value: str | None) -> int:
        if value is None:
            value = ""
        existing = self._index.get(value)
        if existing is not None:
            return existing
        position = len(self._strings)
        self._index[value] = position
        self._strings.append(value)
        return position

    def __len__(self) -> int:
        return len(self._strings)

    def to_bytes(self) -> bytes:
        out = bytearray()
        out += STRING_MAGIC
        out += len(self._strings).to_bytes(4, "little")
        for value in self._strings:
            raw = value.encode("utf-8")
            out += len(raw).to_bytes(4, "little")
            out += raw
        return bytes(out)


@dataclass
class EmitOptions:
    encrypt: bool = False
    passphrase: str | None = None
    single_file: bool = False
    include_source: bool = True
    max_floor_detail: int | None = None
    # Change tracking (history.py): compare against this summary when given
    # (``--compare REV``), otherwise against the last build into `out_dir`.
    baseline: dict | None = None
    track_history: bool = True


@dataclass
class EmitResult:
    out_dir: str
    manifest: dict = field(default_factory=dict)
    strings: StringTable | None = None
    bytes_written: int = 0
    encrypted: bool = False
    encryption_seconds: float = 0.0
    source_bytes: int = 0
    single_file_path: str | None = None
    single_file_note: str = ""


def _write(path: str, data: bytes) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def _json(data) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _camera(bounds_w: float, bounds_h: float, max_height: float) -> dict:
    span = max(bounds_w, bounds_h)
    centre_x = bounds_w / 2.0
    centre_z = bounds_h / 2.0
    # Look at a point partway up the skyline, from outside the city and high
    # enough to see the whole footprint.
    target_y = max(6.0, max_height * 0.28)
    return {
        "eye": [centre_x, span * 0.55, centre_z + span * 1.35],
        "target": [centre_x, target_y, centre_z],
        "fov": 55.0,
        "near": 0.5,
        "far": max(2000.0, span * 8.0),
    }


def _building_order(analysis: RepoAnalysis, layout: CityLayout) -> dict[str, int]:
    """Building id for every path: districts in layout order, files by path."""
    district_order = {d.key: i for i, d in enumerate(layout.districts)}
    by_district: dict[str, list[str]] = {}
    for record in analysis.files:
        by_district.setdefault(record.district, []).append(record.rel)
    order: dict[str, int] = {}
    for key in sorted(by_district, key=lambda k: district_order.get(k, 0)):
        for rel in sorted(by_district[key]):
            order[rel] = len(order)
    return order


def _regions(layout: CityLayout, strings: StringTable) -> list[dict]:
    """Every intermediate folder plinth, parents before children."""
    index = {r.key: i for i, r in enumerate(layout.regions)}
    return [
        {
            "id": i,
            "key": strings.add(r.key),
            "name": strings.add(r.name),
            "level": r.level,
            "parent": index.get(r.parent, -1),
            "rect": [round(r.rect.x, 3), round(r.rect.y, 3), round(r.rect.w, 3), round(r.rect.h, 3)],
            "districts": r.districts,
            "buildings": r.buildings,
            "logicalLoc": r.logical_loc,
        }
        for i, r in enumerate(layout.regions)
    ]


def _review(analysis: RepoAnalysis, order: dict[str, int]) -> dict:
    """City Hall's Architect's review: ranked building ids per signal."""
    lists = health_review(analysis)

    def ids(paths):
        return [order[p] for p in paths if p in order]

    return {
        "hotspots": ids(lists["hotspots"]),
        "oversized": ids(lists["oversized"]),
        "knowledge": ids(lists["knowledge"]),
        "orphans": ids(lists["orphans"]),
        "cycles": [ids(c) for c in lists["cycles"]],
        "violations": ids(lists["violations"]),
        "untested": ids(lists["untested"]),
        "drift": ids(lists["drift"]),
        "complexity": ids(lists["complexity"]),
        "defects": ids(lists["defects"]),
        "rising": ids(lists["rising"]),
        "hubs": ids(lists["hubs"]),
        "debt": ids(lists["debt"]),
        "clones": [ids(pair) for pair in lists["clones"]],
        "hiddenCoupling": [ids(pair) for pair in lists["hiddenCoupling"]],
        "totals": {
            "defects": sum(1 for f in analysis.files if f.is_defect),
            "rising": sum(1 for f in analysis.files if f.is_rising_hotspot),
            "hubs": sum(1 for f in analysis.files if f.is_hub),
            "debt": sum(len(f.debt) for f in analysis.files),
            "clones": len(analysis.clones),
            "hiddenCoupling": len(analysis.hidden_couplings),
            "violations": sum(1 for f in analysis.files if f.is_violation),
            "untested": sum(1 for f in analysis.files if f.untested_risk),
            "drift": sum(1 for f in analysis.files if f.owner_drift),
            "unowned": sum(1 for f in analysis.files if f.is_unowned),
            "complexity": sum(1 for f in analysis.files if f.is_braced),
            "hotspots": sum(1 for f in analysis.files if f.is_hotspot),
            "oversized": sum(1 for f in analysis.files if f.is_oversized),
            "knowledge": sum(1 for f in analysis.files if f.knowledge_risk),
            "orphans": sum(1 for f in analysis.files if f.is_orphan),
            "cycles": len(analysis.cycles),
        },
    }


def _subfolders_of(members: list[FileMetrics], district_key: str, depth: int) -> list[dict]:
    """One level of sub-folder structure below a district's own depth (S13).

    Deliberately not a full recursive re-layout of the treemap -- that risks
    the plaza reservation and street geometry every district's rect already
    depends on (see `layout.build_layout`). This is purely additive metadata:
    the district's own rect, buildings and chunk are completely unchanged: a
    breakdown of what a district's *files* look like one folder deeper, for
    the detail window's "sub-folders" section and the inspector's breadcrumb.
    """
    own_depth = 0 if district_key == ROOT_DISTRICT else district_key.count("/") + 1
    groups: dict[str, dict] = {}
    for record in members:
        dirs = record.rel.split("/")[:-1]
        if len(dirs) <= own_depth:
            continue  # the file sits directly in this district, not deeper
        name = dirs[own_depth]
        bucket = groups.setdefault(name, {"name": name, "files": 0, "loc": 0})
        bucket["files"] += 1
        bucket["loc"] += record.logical_loc
    return sorted(groups.values(), key=lambda g: -g["loc"])


def _district_trend(members: list[FileMetrics]) -> tuple[list[int], list[int]]:
    """Monthly commits and distinct active authors, most recent month first."""
    buckets = max((len(f.activity) for f in members), default=0)
    commits = [0] * buckets
    authors: list[set[str]] = [set() for _ in range(buckets)]
    for record in members:
        for i, value in enumerate(record.activity):
            commits[i] += value
        for author, touched in record.author_buckets.items():
            for i in touched:
                if 0 <= i < buckets:
                    authors[i].add(author)
    return commits, [len(a) for a in authors]


def _experts(members: list[FileMetrics], strings: StringTable, limit: int = 3) -> list[dict]:
    """Who to ask about a folder: recency-weighted authorship summed over its files."""
    scores: dict[str, float] = {}
    for record in members:
        for author, score in record.expert_scores.items():
            scores[author] = scores.get(author, 0.0) + score
    total = sum(scores.values())
    if total <= 0:
        return []
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    return [{"name": strings.add(author), "share": round(score / total, 4)} for author, score in ranked if score > 0]


def _district_extras(key: str, members: list[FileMetrics], arch, strings: StringTable, flags) -> dict:
    deps = arch.districts.get(key) if arch is not None else None
    commits, active = _district_trend(members)
    code = [f for f in members if f.is_tested or f.is_untested]
    return {
        # Dependency structure (architecture.py): Ca, Ce and I = Ce / (Ca + Ce).
        "ca": deps.ca if deps else 0,
        "ce": deps.ce if deps else 0,
        "instability": deps.instability if deps and deps.instability is not None else -1,
        "edgesIn": deps.edges_in if deps else 0,
        "edgesOut": deps.edges_out if deps else 0,
        "violations": deps.violations if deps else 0,
        # Trend: commits and distinct active authors per month, newest first.
        "activity": commits,
        "activeAuthors": active if flags.authorship else [],
        "experts": _experts(members, strings) if flags.authorship else [],
        # Tests, ownership and complexity (testmap.py, owners.py).
        "sourceFiles": len(code),
        "testedFiles": sum(1 for f in code if f.is_tested),
        "untestedRisk": sum(1 for f in members if f.untested_risk),
        "ownerDrift": sum(1 for f in members if f.owner_drift),
        "unowned": sum(1 for f in members if f.is_unowned),
        "braced": sum(1 for f in members if f.is_braced),
        "changed": sum(1 for f in members if f.delta) if flags.delta else 0,
        # The deeper signals, per folder.
        "classes": deps.classes if deps else 0,
        "abstractClasses": deps.abstract_classes if deps else 0,
        "abstractness": deps.abstractness if deps and deps.abstractness is not None else -1,
        "distance": deps.distance if deps and deps.distance is not None else -1,
        "zone": deps.zone if deps else "",
        "recentAuthors": deps.recent_authors if deps else 0,
        "crossShare": deps.cross_share if deps else 0.0,
        "topShare": deps.top_share if deps else 0.0,
        "manyCooks": bool(deps and deps.many_cooks),
        "defects": sum(1 for f in members if f.is_defect),
        "rising": sum(1 for f in members if f.is_rising_hotspot),
        "hubs": sum(1 for f in members if f.is_hub),
        "clones": sum(1 for f in members if f.is_clone),
        "debt": sum(len(f.debt) for f in members),
    }


def _dependencies(analysis: RepoAnalysis, layout: CityLayout, strings: StringTable) -> dict | None:
    """The folder-level dependency picture, by district id."""
    arch = analysis.architecture
    if arch is None or not analysis.flags.imports:
        return None
    district_id = {d.key: i for i, d in enumerate(layout.districts)}
    matrix = sorted(
        ([district_id[a], district_id[b], n] for (a, b), n in arch.matrix.items() if a in district_id and b in district_id),
        key=lambda row: (-row[2], row[0], row[1]),
    )
    violating_pairs: dict[tuple[int, int], int] = {}
    by_rel = {f.rel: f for f in analysis.files}
    for src, dst, _reason in arch.violations:
        a, b = by_rel[src].district, by_rel[dst].district
        if a in district_id and b in district_id and a != b:
            key = (district_id[a], district_id[b])
            violating_pairs[key] = violating_pairs.get(key, 0) + 1
    return {
        # A path inside the repository (".zion/rules.json") or "majority" --
        # schema, not repository content, but interned all the same.
        "rules": strings.add(arch.rules) if arch.rules else -1,
        "rulesError": strings.add(arch.rules_error) if arch.rules_error else -1,
        "matrix": matrix,
        "violatingPairs": [[a, b, n] for (a, b), n in sorted(violating_pairs.items(), key=lambda kv: -kv[1])],
        "coupling": [
            [district_id[a], district_id[b], n, c] for a, b, n, c in arch.coupling if a in district_id and b in district_id
        ],
        "violations": len(arch.violations),
    }


def _delta(analysis: RepoAnalysis, order: dict[str, int], strings: StringTable) -> dict | None:
    delta = analysis.delta
    if not delta:
        return None

    def ids(paths):
        return [order[p] for p in paths if p in order]

    path_keyed = delta["baseline"].get("keying") == "path"
    head = delta["baseline"].get("head") or ""
    return {
        "baseline": {
            "generated": delta["baseline"].get("generated", ""),
            "head": head[:12],
            "headTs": delta["baseline"].get("headTs", 0.0),
            "label": strings.add(delta["baseline"]["label"]) if delta["baseline"].get("label") else -1,
        },
        "added": ids(delta["added"]),
        "grown": [[order[p], d] for p, d in delta["grown"] if p in order],
        "shrunk": [[order[p], d] for p, d in delta["shrunk"] if p in order],
        # A removed file has no building; name it only when the baseline was
        # keyed by path (an encrypted city's baseline is keyed by HMAC).
        "removed": [[strings.add(k) if path_keyed else -1, loc] for k, loc in delta["removed"][:200]],
        "removedCount": len(delta["removed"]),
        "became": {name: ids(paths) for name, paths in delta["became"].items()},
        "resolved": dict(delta["resolved"]),
        "before": dict(delta["before"]),
        "after": dict(delta["after"]),
    }


def build_manifest(
    analysis: RepoAnalysis,
    layout: CityLayout,
    strings: StringTable,
    options: EmitOptions,
    crypto_meta: dict | None,
) -> dict:
    buildings_total = len(analysis.files)
    max_height = max((f.height for f in analysis.files), default=0.0)
    order = _building_order(analysis, layout)
    git = analysis.git
    git_first = git.first_ts if git is not None and git.available else 0.0
    git_last = git.last_ts if git is not None and git.available else 0.0

    flags = analysis.flags
    arch = analysis.architecture
    legend = []
    enable_map = {
        "hotspots": flags.hotspots,
        "knowledge": flags.knowledge,
        "orphans": flags.imports,
        "cycles": flags.imports and bool(analysis.cycles),
        "author_tint": flags.authorship,
        "churn": flags.churn,
        "weathering": flags.recency,
        "skybridges": flags.coupling,
        "new_construction": flags.age,
        "heat": flags.churn,
        "downtown": flags.centrality,
        "sole_tenant": flags.authorship,
        "untested": flags.tests,
        "complexity": flags.complexity,
        "imports": flags.imports,
        "instability": flags.imports,
        "violations": flags.layering,
        "district_coupling": flags.coupling and bool(arch is not None and arch.coupling),
        "codeowners": flags.codeowners,
        "experts": flags.authorship,
        "delta": flags.delta,
        "timeline": flags.age,
        "defects": flags.defects,
        "hubs": flags.hubs,
        "debt": flags.debt,
        "trend": flags.trend,
        "hidden_coupling": flags.hidden_coupling,
        "clones": flags.clones,
        "abstractness": flags.abstractness,
        "teams": flags.teams,
    }
    for entry_id, label, unit, group, description in LEGEND_SPEC:
        enabled = enable_map.get(entry_id, True)
        legend.append(
            {
                "id": entry_id,
                # A literal, not a string-table index: the legend describes what
                # the city *means*, which is public schema rather than repository
                # data, so it stays readable in a locked city. Notes and stats,
                # which do describe the repo, remain table indices.
                "label": label,
                "unit": unit,
                "group": group,
                "description": description,
                "enabled": enabled,
            }
        )

    # ---- districts, with skyline envelopes for the overview impostors ----
    # Group once: scanning every file for every district is O(districts x files),
    # which at 320 districts and 50,000 files is 16M comparisons per pass.
    members_by_district: dict[str, list[FileMetrics]] = {}
    for record in analysis.files:
        members_by_district.setdefault(record.district, []).append(record)

    # City-wide mean downtown density, so a district needs the CBD_DENSITY_MULTIPLE
    # rule imported from metrics.py rather than a magic number duplicated here.
    from .metrics import CBD_DENSITY_MULTIPLE

    city_downtown_share = (
        sum(1 for f in analysis.files if f.downtown) / len(analysis.files) if analysis.files else 0.0
    )

    districts = []
    for index, district in enumerate(layout.districts):
        members = members_by_district.get(district.key, [])
        heights = [f.height for f in members] or [0.0]
        envelope_w = max((b.width for b in district.buildings), default=0.0)
        envelope_d = max((b.depth for b in district.buildings), default=0.0)
        districts.append(
            {
                "id": index,
                "key": strings.add(district.key),
                "name": strings.add(district.name),
                # Ancestor folder names, for a breadcrumb -- "repo / src /
                # analyzer" -- even though only the leaf is its own district
                # block (S13's "first version": metadata, not a re-layout).
                "pathSegments": [strings.add(seg) for seg in district.key.split("/")]
                if district.key != ROOT_DISTRICT
                else [],
                "subfolders": [
                    {"name": strings.add(g["name"]), "files": g["files"], "loc": g["loc"]}
                    for g in _subfolders_of(members, district.key, layout.depth)
                ],
                "rect": [
                    round(district.rect.x, 3),
                    round(district.rect.y, 3),
                    round(district.rect.w, 3),
                    round(district.rect.h, 3),
                ],
                "buildings": district.building_count,
                "weight": round(district.weight, 3),
                "hasReadme": district.has_readme,
                "readmeRel": strings.add(district.readme_rel) if district.readme_rel else -1,
                "mayor": strings.add(district.mayor) if district.mayor else -1,
                "primaryLanguage": strings.add(district.primary_language),
                "logicalLoc": district.logical_loc,
                "documented": district.documented,
                "testFiles": district.test_files,
                "dataFiles": district.data_files,
                "level": district.level,
                "region": strings.add(district.region) if district.region else -1,
                "contributors": district.contributors,
                "busFactor": district.bus_factor,
                "hotspots": district.hotspots,
                "oversized": district.oversized,
                "orphans": district.orphans,
                "knowledgeRisks": district.knowledge_risks,
                "cycles": district.cycles,
                # Mean heat over the district's own files, not a city-wide
                # average -- "this neighbourhood is under active development"
                # relative to the district's own population.
                "heat": round(sum(f.heat for f in members) / len(members), 4) if members and flags.churn else 0.0,
                **_district_extras(district.key, members, arch, strings, flags),
                "newFiles": sum(1 for f in members if f.is_new) if flags.age else 0,
                "isCbd": (
                    flags.centrality
                    and bool(members)
                    and city_downtown_share > 0
                    and (sum(1 for f in members if f.downtown) / len(members)) >= city_downtown_share * CBD_DENSITY_MULTIPLE
                ),
                "skyline": {
                    "maxHeight": round(max(heights), 2),
                    "avgHeight": round(sum(heights) / len(heights), 2),
                    "envelope": [round(envelope_w, 2), round(envelope_d, 2)],
                },
                "chunk": f"d/{index:04d}.json",
            }
        )

    # ---- repo-wide stats for City Hall ----
    languages: dict[str, dict] = {}
    for record in analysis.files:
        bucket = languages.setdefault(record.language, {"files": 0, "loc": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["loc"] += record.logical_loc
        bucket["bytes"] += record.size
    language_rows = [
        {"name": strings.add(name), "files": v["files"], "loc": v["loc"], "bytes": v["bytes"]}
        for name, v in sorted(languages.items(), key=lambda kv: -kv[1]["loc"])
    ]

    author_rows = []
    if flags.authorship:
        owners: dict[str, dict] = {}
        for record in analysis.files:
            for author, lines in record.authors.items():
                entry = owners.setdefault(author, {"lines": 0, "files": 0})
                entry["lines"] += lines
                entry["files"] += 1
        author_rows = [
            {"name": strings.add(name), "lines": v["lines"], "files": v["files"]}
            for name, v in sorted(owners.items(), key=lambda kv: -kv[1]["lines"])
        ]

    largest = sorted(analysis.files, key=lambda f: -f.logical_loc)[:12]
    largest_rows = [
        {
            "path": strings.add(f.rel),
            "loc": f.logical_loc,
            "bytes": f.size,
            "language": strings.add(f.language),
            "floors": len(f.floors),
            "documented": round(f.doc_ratio, 3),
        }
        for f in largest
    ]

    folder_rows = [
        {
            "name": strings.add(d.key),
            "buildings": d.building_count,
            "loc": d.logical_loc,
            "hasReadme": d.has_readme,
            "documented": d.documented,
            "language": strings.add(d.primary_language),
        }
        for d in layout.districts
    ]

    districts_with_readme = sum(1 for d in layout.districts if d.has_readme)
    documented_files = analysis.documented_files
    doc_coverage = documented_files / max(1, buildings_total)

    notes = [strings.add(note) for note in flags.notes]
    if not districts_with_readme:
        notes.append(strings.add("No district has its own README."))

    stats = {
        "fileCount": buildings_total,
        "districtCount": len(layout.districts),
        "logicalLoc": analysis.total_logical_loc,
        "totalBytes": analysis.total_bytes,
        "documentedFiles": documented_files,
        "docCoverage": round(doc_coverage, 4),
        "districtsWithReadme": districts_with_readme,
        "districtsTotal": len(layout.districts),
        "languages": language_rows,
        "authors": author_rows,
        "largestFiles": largest_rows,
        "folders": folder_rows,
        "notes": notes,
    }

    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "meta": {
            "generated": _now_iso(),
            "walker": analysis.walk_source,
            "noiseExcluded": analysis.noise_excluded,
            "truncated": analysis.truncated,
            "districtDepth": layout.depth,
            "buildingCount": buildings_total,
            "sourceMode": "full" if options.include_source else "none",
            "encrypted": bool(options.encrypt),
            # The repository's folder name, interned: it keys the reader's own
            # notes in the viewer (notes.js) and is withheld while locked.
            "name": strings.add(os.path.basename(os.path.abspath(analysis.root)) or "repo"),
            # The span of the history the History slider scrubs, in days back
            # from the newest commit (the same origin every age is measured from).
            "historyDays": round(max(0.0, (git_last - git_first) / 86400.0), 1),
            "headTs": git_last,
        },
        "crypto": crypto_meta,
        "flags": flags.to_dict(),
        "legend": legend,
        "bounds": [
            round(layout.bounds.x, 3),
            round(layout.bounds.y, 3),
            round(layout.bounds.w, 3),
            round(layout.bounds.h, 3),
        ],
        # [x, y, w, h, class]: class 0 highway, 1 avenue, 2 street, 3 alley.
        "streets": [
            [round(s.x, 2), round(s.y, 2), round(s.w, 2), round(s.h, 2), s.cls] for s in layout.streets
        ],
        "roads": {"names": list(ROAD_NAMES), "widths": [round(w, 2) for w in layout.road_widths]},
        "regions": _regions(layout, strings),
        "review": _review(analysis, order),
        "dependencies": _dependencies(analysis, layout, strings),
        "delta": _delta(analysis, order, strings),
        "codeowners": strings.add(analysis.codeowners_path) if analysis.codeowners_path else -1,
        "cityHall": layout.city_hall(),
        "camera": _camera(layout.bounds.w, layout.bounds.h, max_height),
        "districts": districts,
        "stats": stats,
        # Only a pointer: the file itself is empty/absent whenever coupling is
        # disabled, so the viewer's "should I fetch this" check is one flag read.
        "bridges": "bridges.json" if flags.coupling else None,
        # Import edges `[[fromId, toId, violates], ...]`: ids only, so they are
        # the same bytes in a plain and an encrypted build.
        "imports": "imports.json" if flags.imports else None,
        "index": "index.json",
        "indexColumns": INDEX_COLUMNS,
        "extTable": "ext.bin",
    }
    return manifest


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Viewer installation
# --------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def install_viewer(out_dir: str) -> int:
    """Copy the viewer and its vendored three.js next to the city data.

    The output directory becomes the whole website: `zion serve` only has to
    serve one folder, and a build stays self-contained when archived.
    """
    import shutil

    written = 0
    viewer = os.path.join(REPO_ROOT, "viewer")
    vendor = os.path.join(REPO_ROOT, "vendor")

    os.makedirs(os.path.join(out_dir, "js"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "css"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "vendor"), exist_ok=True)

    for rel in ("index.html", "detail.html", os.path.join("css", "hud.css")):
        destination = os.path.join(out_dir, rel)
        shutil.copyfile(os.path.join(viewer, rel), destination)
        written += os.path.getsize(destination)

    # The viewer's modules are copied as a tree, not as a flat folder: the
    # geometry assemblies live under `js/parts/`, and a build that dropped them
    # would serve a viewer whose import graph 404s.
    for root, _dirs, files in os.walk(os.path.join(viewer, "js")):
        for name in sorted(files):
            if not name.endswith(".js"):
                continue
            source = os.path.join(root, name)
            destination = os.path.join(out_dir, os.path.relpath(source, viewer))
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.copyfile(source, destination)
            written += os.path.getsize(destination)

    three = os.path.join(vendor, "three.module.js")
    if os.path.exists(three):
        destination = os.path.join(out_dir, "vendor", "three.module.js")
        shutil.copyfile(three, destination)
        written += os.path.getsize(destination)

    return written


# --------------------------------------------------------------------------
# Chunks and floor detail
# --------------------------------------------------------------------------


# Bits of index.json's flagsBitmask column. Append-only: a new bit is added
# by a later phase (isNew, isDowntown) when that data exists, never
# renumbered, so an older cached index.json's bits keep meaning the same thing.
FLAG_IS_TEST = 1 << 0
FLAG_IS_DOC = 1 << 1
FLAG_IS_BINARY = 1 << 2
FLAG_IS_RUIN = 1 << 3
FLAG_IS_DATA = 1 << 4
FLAG_TOP_CHURN = 1 << 5
FLAG_IS_NEW = 1 << 6
FLAG_IS_DOWNTOWN = 1 << 7
FLAG_SOLE_TENANT = 1 << 8
FLAG_HOTSPOT = 1 << 9
FLAG_OVERSIZED = 1 << 10
FLAG_ORPHAN = 1 << 11
FLAG_CYCLE = 1 << 12
FLAG_KNOWLEDGE = 1 << 13
FLAG_VIOLATION = 1 << 14
FLAG_UNTESTED = 1 << 15
FLAG_UNTESTED_RISK = 1 << 16
FLAG_DRIFT = 1 << 17
FLAG_ADDED = 1 << 18
FLAG_GROWN = 1 << 19
FLAG_SHRUNK = 1 << 20
FLAG_BRACED = 1 << 21
FLAG_UNOWNED = 1 << 22
FLAG_DEFECT = 1 << 23
FLAG_RISING = 1 << 24
FLAG_HUB = 1 << 25
FLAG_CLONE = 1 << 26
FLAG_HIDDEN_COUPLING = 1 << 27

# index.json's row shape, in column order. Kept as a manifest field so the
# viewer never hardcodes positions -- a later phase appends a column here and
# the viewer reads it by name, not by index literal.
INDEX_COLUMNS = [
    "id", "district", "archetype", "language", "ext", "name", "flags", "loc", "age", "heat", "path",
    # Appended for the richer query tokens (owner:, cx>, fanin>, fanout>, delta>).
    "owner", "cx", "fanin", "fanout", "delta",
    # Appended for the deeper signals (fixes>, trend, todo>, depth>).
    "fixes", "trend", "debt", "depth",
]


def _ext_for(rel: str) -> str:
    _, ext = os.path.splitext(rel)
    return ext.lower() if ext else "(none)"


def _top_decile_churn(files: list[FileMetrics]) -> set[str]:
    """Paths in the top decile of *recent* activity (``heat``) -- the set
    cranes are drawn from.

    ``heat`` is an exponentially-decayed, percentile-ranked score (see
    ``metrics._finalize_time_signals``): a file with a burst of commits last
    week outranks one with the same lifetime churn spread evenly across
    years. Falls back to lifetime churn only for files metrics.py never
    reached (heat left at its 0.0 default), so a repo built before this field
    existed still degrades to the old behaviour rather than losing cranes.
    """
    with_heat = [f for f in files if f.heat > 0]
    if with_heat:
        cutoff_rank = 0.9
        return {f.rel for f in with_heat if f.heat >= cutoff_rank}
    churny = sorted((f for f in files if f.churn > 0), key=lambda f: -f.churn)
    if not churny:
        return set()
    cutoff = max(1, len(churny) // 10)
    return {f.rel for f in churny[:cutoff]}


def _building_record(
    index: int,
    record: FileMetrics,
    strings: StringTable,
    district_id: int,
    placed=None,
    top_churn: frozenset[str] = frozenset(),
    order: dict[str, int] | None = None,
) -> dict:
    order = order or {}
    placement = {
        "x": round(placed.x, 3) if placed else 0.0,
        "y": round(placed.y, 3) if placed else 0.0,
        "width": round(placed.width, 3) if placed else 4.0,
        "depth": round(placed.depth, 3) if placed else 4.0,
    }
    return {
        "id": index,
        **placement,
        "district": district_id,
        "name": strings.add(record.name),
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "archetype": record.archetype,
        "loc": record.logical_loc,
        "physicalLines": record.physical_lines,
        "bytes": record.size,
        "floors": len(record.floors),
        "docRatio": round(record.doc_ratio, 4),
        "lit": None if record.lit_windows is None else round(record.lit_windows, 4),
        "isTest": record.is_test,
        "isDoc": record.is_doc,
        "isBinary": record.is_binary,
        "isRuin": record.is_ruin,
        "rows": record.rows,
        "conf": record.confidence,
        "parseConfidence": record.parse_confidence,
        "commits": record.commits,
        "churn": record.churn,
        "topChurn": record.rel in top_churn,
        "recencyDays": round(record.recency_days, 1),
        "ageDays": round(record.age_days, 1),
        "isNew": record.is_new,
        "era": record.era,
        "activity": list(record.activity),
        "heat": round(record.heat, 4),
        "centrality": round(record.centrality, 4),
        "downtown": record.downtown,
        "importInDegree": record.import_in_degree,
        "soleTenant": record.sole_tenant,
        "author": strings.add(record.primary_author) if record.primary_author else -1,
        "ownership": round(record.ownership_share, 3),
        "lastMessage": strings.add(record.last_message) if record.last_message else -1,
        # People: who made it, who last touched it -- days are measured back
        # from the repository's newest commit, so they are identical in a
        # plain and an encrypted build of the same history.
        "firstAuthor": strings.add(record.first_author) if record.first_author else -1,
        "lastAuthor": strings.add(record.last_author) if record.last_author else -1,
        "authorCount": record.author_count,
        "busFactor": record.bus_factor,
        "ownerAwayDays": round(record.owner_away_days, 1),
        "ownerInactive": record.owner_inactive,
        # Architect's signals (analyzer/health.py).
        "hotspot": record.hotspot,
        "hotspotRank": record.hotspot_rank,
        "isHotspot": record.is_hotspot,
        "sizePct": round(record.size_pct, 4),
        "oversized": record.is_oversized,
        "longestFloor": (
            {"name": strings.add(record.longest_floor[0]), "loc": record.longest_floor[1]}
            if record.longest_floor else None
        ),
        "maxComplexity": record.max_complexity,
        "orphan": record.is_orphan,
        "knowledgeRisk": record.knowledge_risk,
        "cycle": record.cycle_id,
        "cycleSize": record.cycle_size,
        # Dependency structure (architecture.py).
        "importsOut": len(record.imports_resolved),
        "instability": record.file_instability,
        "violations": len(record.import_violations),
        # Ownership (owners.py): shares of lines added, and who to ask.
        "authorShares": [[strings.add(a), share] for a, share in record.author_shares],
        "experts": [[strings.add(a), share] for a, share in record.experts],
        "declaredOwners": [strings.add(o) for o in record.declared_owners],
        "ownerDrift": record.owner_drift,
        "unowned": record.is_unowned,
        # Tests and complexity (testmap.py).
        "testedBy": [order[t] for t in record.tested_by if t in order][:8],
        "untested": record.is_untested,
        "untestedRisk": record.untested_risk,
        "braced": record.is_braced,
        "braceComplexity": record.brace_complexity,
        # Change since the baseline (history.py).
        "delta": record.delta,
        "locDelta": record.loc_delta,
        "became": list(record.became),
        # The deeper signals (health.py, architecture.py, clones.py).
        "fixCommits": record.fix_commits,
        "fixRatio": record.fix_ratio,
        "isDefect": record.is_defect,
        "trend": record.trend,
        "risingHotspot": record.is_rising_hotspot,
        "isHub": record.is_hub,
        "importDepth": record.import_depth,
        "classes": record.classes,
        "abstractClasses": record.abstract_classes,
        # Comment text goes through the string table: a locked city shows the
        # count and the line, never what the comment said.
        "debt": [[line, marker, strings.add(text) if text else -1] for line, marker, text in record.debt],
        # Partners are building ids, so an encrypted city leaks no path.
        "cloneOf": [[order[o], ratio] for o, ratio in record.clone_of if o in order],
        "hiddenCoupling": [[order[o], count] for o, count in record.hidden_coupling if o in order],
        "height": round(record.height, 2),
        "footprint": round(record.footprint, 2),
        "plate": round(record.logical_loc / len(record.floors), 1) if record.floors else None,
        "detail": f"f/{index}.json",
        "source": f"f/{index}.src" if _includes_source(record) else "",
    }


def _build_index(
    analysis: RepoAnalysis,
    building_index: dict[str, int],
    district_order: dict[str, int],
    strings: StringTable,
    ext_strings: StringTable,
    top_churn: frozenset[str],
) -> list[list]:
    """Build ``index.json``: one compact row per building, for whole-repo
    filtering/counting without fetching every district chunk (the viewer only
    keeps camera-resident chunks loaded; see ``DistrictStreamer``).

    Name and language go through the encrypted string table, same as building
    records -- a locked city withholds them until unlock. Extension goes
    through its own always-plaintext table, deliberately separate, so
    ``ext:py`` style filtering works even while locked: an extension is not a
    filename and does not leak one.
    """
    rows = []
    for record in analysis.files:
        index = building_index.get(record.rel)
        if index is None:
            continue
        flags = 0
        if record.is_test:
            flags |= FLAG_IS_TEST
        if record.is_doc:
            flags |= FLAG_IS_DOC
        if record.is_binary:
            flags |= FLAG_IS_BINARY
        if record.is_ruin:
            flags |= FLAG_IS_RUIN
        if record.rows is not None:
            flags |= FLAG_IS_DATA
        if record.rel in top_churn:
            flags |= FLAG_TOP_CHURN
        if record.is_new:
            flags |= FLAG_IS_NEW
        if record.downtown:
            flags |= FLAG_IS_DOWNTOWN
        if record.sole_tenant:
            flags |= FLAG_SOLE_TENANT
        if record.is_hotspot:
            flags |= FLAG_HOTSPOT
        if record.is_oversized:
            flags |= FLAG_OVERSIZED
        if record.is_orphan:
            flags |= FLAG_ORPHAN
        if record.cycle_id:
            flags |= FLAG_CYCLE
        if record.knowledge_risk:
            flags |= FLAG_KNOWLEDGE
        if record.is_violation:
            flags |= FLAG_VIOLATION
        if record.is_untested:
            flags |= FLAG_UNTESTED
        if record.untested_risk:
            flags |= FLAG_UNTESTED_RISK
        if record.owner_drift:
            flags |= FLAG_DRIFT
        if record.delta == "added":
            flags |= FLAG_ADDED
        elif record.delta == "grown":
            flags |= FLAG_GROWN
        elif record.delta == "shrunk":
            flags |= FLAG_SHRUNK
        if record.is_braced:
            flags |= FLAG_BRACED
        if record.is_unowned:
            flags |= FLAG_UNOWNED
        if record.is_defect:
            flags |= FLAG_DEFECT
        if record.is_rising_hotspot:
            flags |= FLAG_RISING
        if record.is_hub:
            flags |= FLAG_HUB
        if record.is_clone:
            flags |= FLAG_CLONE
        if record.is_hidden_coupling:
            flags |= FLAG_HIDDEN_COUPLING
        rows.append(
            [
                index,
                district_order.get(record.district, 0),
                record.archetype,
                strings.add(record.language),
                ext_strings.add(_ext_for(record.rel)),
                strings.add(record.name),
                flags,
                record.logical_loc,
                round(record.age_days, 1),
                round(record.heat, 4),
                strings.add(record.rel),
                strings.add(record.primary_author) if record.primary_author else -1,
                record.max_complexity,
                record.import_in_degree,
                len(record.imports_resolved),
                record.loc_delta,
                record.fix_commits,
                record.trend,
                len(record.debt),
                record.import_depth,
            ]
        )
    rows.sort(key=lambda row: row[0])
    return rows


def _includes_source(record: FileMetrics) -> bool:
    return not record.is_binary and record.size > 0


def _floor_payload(record: FileMetrics, strings: StringTable) -> tuple[dict, bytes]:
    """Build ``f/<id>.json`` plus the raw ``f/<id>.src`` bytes.

    Floors carry byte offsets into the source blob rather than escaped text, so
    the viewer can slice exactly what the parser saw without JSON escaping a
    10 MB HTML corpus.
    """
    if record.is_binary:
        # The path is interned, not written literally: a locked city must not
        # leak a filename through the floor detail file.
        return (
            {
                "id": None,
                "path": strings.add(record.rel),
                "language": strings.add(record.language),
                "binary": True,
                "bytes": record.size,
                "srcBytes": 0,
                "floors": [],
            },
            b"",
        )

    try:
        source = parse_pkg.read_text(record.abspath)
    except OSError:
        source = ""

    # A notebook's useful source is its cell source, not the ipynb JSON wrapper
    # (which is mostly base64 image output).  Concatenate the cells so the
    # floors' offsets point at readable code.
    if record.language == "notebook":
        return _notebook_payload(record, strings, source)

    blob = source.encode("utf-8", errors="replace")

    # Offsets are computed over the encoded blob so multi-byte characters in
    # docstrings do not shift a floor's slice.  ``offsets[0]`` is the start of
    # line 1, so line N starts at ``offsets[N - 1]``; floor spans are half-open
    # ``[line, end_line)`` to match every parser.
    offsets = _line_offsets(blob)
    last = len(offsets) - 1
    floors = []
    for floor in record.floors:
        start_line = max(1, min(floor.line or 1, last + 1))
        end_line = max(start_line + 1, floor.end_line or (start_line + 1))
        start = offsets[start_line - 1]
        end = offsets[min(end_line - 1, last)]
        floors.append(
            {
                "name": strings.add(floor.name),
                "kind": floor.kind,
                "doc": strings.add(floor.doc) if floor.doc else -1,
                "line": floor.line,
                "endLine": floor.end_line,
                "loc": floor.loc,
                "depth": floor.depth,
                "complexity": floor.complexity,
                "isEntrypoint": floor.is_entrypoint,
                "srcOffset": start,
                "srcLength": max(0, end - start),
            }
        )

    payload = {
        "id": None,
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "loc": record.logical_loc,
        "binary": False,
        "srcBytes": len(blob),
        "floors": floors,
    }
    return payload, blob


def _notebook_payload(record: FileMetrics, strings: StringTable, source: str) -> tuple[dict, bytes]:
    """Cell source, not the ipynb wrapper, is what a notebook's interior shows."""
    import json as _jsonlib

    try:
        doc = _jsonlib.loads(source)
    except ValueError:
        doc = {}
    cells = doc.get("cells") if isinstance(doc, dict) else None
    if not isinstance(cells, list):
        cells = []
        for sheet in (doc.get("worksheets") if isinstance(doc, dict) else None) or []:
            if isinstance(sheet, dict):
                cells.extend(sheet.get("cells") or [])

    blob = bytearray()
    floors = []
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        kind = cell.get("cell_type")
        raw = cell.get("source") or cell.get("input") or ""
        if isinstance(raw, list):
            raw = "".join(str(p) for p in raw)
        text = str(raw)
        if not text.strip():
            continue
        encoded = text.encode("utf-8", errors="replace")
        start = len(blob)
        blob += encoded
        if not text.endswith("\n"):
            blob += b"\n"
        first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        floors.append(
            {
                "name": strings.add(_trim(first, 80) or ("cell" if kind == "code" else "note")),
                "kind": "cell" if kind == "code" else "heading",
                "doc": strings.add(_trim(first)) if first else -1,
                "line": 0,
                "endLine": 0,
                "loc": len(encoded),
                "depth": 0,
                "srcOffset": start,
                "srcLength": len(encoded),
            }
        )

    payload = {
        "id": None,
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "loc": record.logical_loc,
        "binary": False,
        "srcBytes": len(blob),
        "floors": floors,
    }
    return payload, bytes(blob)


def _trim(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def _line_offsets(blob: bytes) -> list[int]:
    """Byte offset of each line start, found at C speed."""
    offsets = [0]
    position = blob.find(b"\n")
    while position != -1:
        offsets.append(position + 1)
        position = blob.find(b"\n", position + 1)
    return offsets


# --------------------------------------------------------------------------
# Top-level emit
# --------------------------------------------------------------------------


def emit_city(
    analysis: RepoAnalysis,
    out_dir: str,
    options: EmitOptions | None = None,
    layout: CityLayout | None = None,
    progress=None,
) -> EmitResult:
    options = options or EmitOptions()
    layout = layout or build_layout(analysis)
    strings = StringTable()
    result = EmitResult(out_dir=out_dir, strings=strings, encrypted=options.encrypt)

    crypto_meta = None
    encryptor = None
    if options.encrypt:
        from . import crypto

        if not options.passphrase:
            raise ValueError("--encrypt requires a passphrase (ZION_PASSPHRASE or prompt)")
        crypto_meta, encryptor = crypto.prepare(options.passphrase)

    # ---- change since the baseline ----
    #
    # Measured before anything is written: the delta rides in the manifest,
    # the chunks and the index, and the previous summary in `out_dir` is only
    # replaced once this build has used it.
    from . import history

    summary_key, keying = history.key_function(options.passphrase if options.encrypt else None)
    current_summary = history.summarize(analysis, summary_key, keying)
    baseline = options.baseline
    if baseline is None and options.track_history:
        baseline = history.previous_baseline(out_dir, current_summary)
    analysis.delta = history.apply_delta(analysis, baseline, summary_key)
    analysis.flags.delta = bool(analysis.delta)

    manifest = build_manifest(analysis, layout, strings, options, crypto_meta)

    # ---- district chunks ----
    by_district: dict[str, list[FileMetrics]] = {}
    for record in analysis.files:
        by_district.setdefault(record.district, []).append(record)

    district_order = {d.key: i for i, d in enumerate(layout.districts)}
    # Placement is computed by layout, so carry it into the chunk records: the
    # viewer positions instances from the chunk, not from the manifest.
    placement = {
        b.rel: b for district in layout.districts for b in district.buildings
    }
    building_index = _building_order(analysis, layout)

    bytes_written = 0
    source_bytes = 0

    top_churn = _top_decile_churn(analysis.files) if analysis.flags.churn else frozenset()

    for key, members in by_district.items():
        district_id = district_order.get(key, 0)
        records = [
            _building_record(
                building_index[m.rel], m, strings, district_id, placement.get(m.rel), top_churn, building_index
            )
            for m in sorted(members, key=lambda f: f.rel)
        ]
        payload = _json({"district": district_id, "buildings": records})
        bytes_written += _write(os.path.join(out_dir, f"d/{district_id:04d}.json"), payload)
        if progress:
            progress(f"district {district_id:04d} {key}")

    # ---- co-change pairs ----
    #
    # Coupling pairs are computed once, over every commit (gitmeta.py), regardless
    # of the bulk-commit exclusion rule's effect on any single file. Only emit
    # them when the degeneration rule says they mean something, and only for
    # pairs where both ends survived into the city (a coupled file that was
    # walked out by .gitignore or noise-exclusion has no building to name here).
    #
    # This used to also draw an arc between every pair directly on the map
    # ("skybridges"). At any real resident-building count that read as an
    # unlabelled tangle with no way to tell one pair from another -- exactly
    # the kind of decoration the legend rule says nothing here may be. It was
    # removed; the data stays, surfaced instead as a named, clickable list
    # ("Changes together with") in a building's detail report
    # (viewer/js/detail.js), where a specific pair can actually be read.
    MAX_BRIDGES = 2000
    if analysis.flags.coupling and analysis.git is not None:
        pairs = sorted(analysis.git.coupling.items(), key=lambda kv: -kv[1])
        bridges = []
        for (path_a, path_b), count in pairs:
            id_a = building_index.get(path_a)
            id_b = building_index.get(path_b)
            if id_a is None or id_b is None:
                continue
            bridges.append([id_a, id_b, count])
            if len(bridges) >= MAX_BRIDGES:
                break
        bytes_written += _write(os.path.join(out_dir, "bridges.json"), _json(bridges))

    # ---- import edges ----
    #
    # Drawn only for the selected building (viewer/js/parts/structure.js), so
    # the whole list is shipped once and never rendered at once.
    MAX_IMPORT_EDGES = 300_000
    if analysis.flags.imports:
        violating = {(f.rel, t) for f in analysis.files for t in f.import_violations}
        edges = []
        for record in analysis.files:
            src = building_index.get(record.rel)
            if src is None:
                continue
            for target in record.imports_resolved:
                dst = building_index.get(target)
                if dst is None:
                    continue
                edges.append([src, dst, 1 if (record.rel, target) in violating else 0])
        edges.sort()
        bytes_written += _write(os.path.join(out_dir, "imports.json"), _json(edges[:MAX_IMPORT_EDGES]))

    # ---- whole-repo facet index ----
    ext_strings = StringTable()
    index_rows = _build_index(analysis, building_index, district_order, strings, ext_strings, top_churn)
    bytes_written += _write(os.path.join(out_dir, "index.json"), _json(index_rows))
    # Always plaintext, regardless of --encrypt: an extension is not a
    # filename, so withholding it behind the vault would disable ext: filters
    # in a locked city for no privacy gained.
    bytes_written += _write(os.path.join(out_dir, "ext.bin"), ext_strings.to_bytes())

    # ---- floor detail ----
    #
    # Payloads are queued rather than written immediately, so encryption can run
    # across processes in one batch. The pure-Python cipher manages ~0.44 MB/s,
    # and interiors carry full source, so a 12 MB corpus would otherwise cost
    # half a minute of single-threaded work.
    import time as _time

    writes: list[tuple[str, bytes, bool, str]] = []
    source_bytes = 0

    for record in analysis.files:
        index = building_index[record.rel]
        payload, blob = _floor_payload(record, strings)
        payload["id"] = index
        writes.append((f"f/{index}.json", _json(payload), True, f"f/{index}.json"))

        if blob and options.include_source:
            source_bytes += len(blob)
            writes.append((f"f/{index}.src", blob, True, f"f/{index}.src"))
        elif not blob:
            # Emit an empty source file so the viewer's fetch path is uniform.
            writes.append((f"f/{index}.src", b"", True, f"f/{index}.src"))

    strings_plain = strings.to_bytes()
    writes.append(("strings.bin", strings_plain, True, "strings.bin"))

    crypto_seconds = 0.0
    if encryptor is not None:
        started = _time.time()
        jobs = [(record_id, data) for _, data, needs, record_id in writes if needs]
        encrypted = encryptor.encrypt_many(jobs)
        iterator = iter(encrypted)
        writes = [
            (path, next(iterator) if needs else data, needs, record_id)
            for path, data, needs, record_id in writes
        ]
        crypto_seconds = _time.time() - started

    for path, data, _needs, _record_id in writes:
        bytes_written += _write(os.path.join(out_dir, path), data)

    # ---- rebuild manifest with the complete string table ----
    manifest = build_manifest(analysis, layout, strings, options, crypto_meta)
    manifest["stringTable"] = {
        "count": len(strings),
        "bytes": len(strings_plain),
        "encrypted": bool(encryptor is not None),
    }
    bytes_written += _write(os.path.join(out_dir, "city.json"), _json(manifest))
    if options.track_history:
        bytes_written += history.write_summaries(out_dir, current_summary)

    bytes_written += install_viewer(out_dir)

    if options.single_file:
        single, note = build_single_file(out_dir, manifest, result)
        result.single_file_path = single
        result.single_file_note = note

    result.manifest = manifest
    result.bytes_written = bytes_written
    result.source_bytes = source_bytes
    result.encryption_seconds = crypto_seconds
    return result


# --------------------------------------------------------------------------
# Single-file build
# --------------------------------------------------------------------------

# Above this, inlining stops being sensible: base64 adds a third on top of the
# payload, and the browser must parse the whole document before the first frame.
SINGLE_FILE_MAX_BYTES = 32 * 1024 * 1024
SINGLE_FILE_MAX_BUILDINGS = 5000


def _rewrite_module_specifiers(source: str, rel_dir: str = "") -> str:
    """Point relative viewer imports at import-map keys.

    Inlined modules have no URL to resolve `./loader.js` against, so each
    module is registered under a bare `zion/<path>` key instead. `rel_dir` is
    the module's own directory inside `js/`, so a nested module's `../` still
    resolves to the right key rather than to whichever file happens to share
    its basename.
    """
    import re

    def key_for(specifier: str) -> str:
        parts: list[str] = []
        for piece in f"{rel_dir}/{specifier}".split("/"):
            if piece in ("", "."):
                continue
            if piece == "..":
                if parts:
                    parts.pop()
                continue
            parts.append(piece)
        return "zion/" + "/".join(parts)[:-3]  # drop the ".js"

    def replace(match: re.Match) -> str:
        prefix, specifier, suffix = match.group(1), match.group(2), match.group(3)
        if specifier.startswith("."):
            return f"{prefix}{key_for(specifier)}{suffix}"
        return match.group(0)

    return re.sub(
        r"(from\s+['\"])([^'\"]+)(['\"])",
        replace,
        source,
    )


def _data_url(source: bytes, mime: str = "text/javascript") -> str:
    import base64

    return f"data:{mime};base64," + base64.b64encode(source).decode("ascii")


def build_single_file(out_dir: str, manifest: dict, result: "EmitResult") -> tuple[str | None, str]:
    """Inline the viewer and the whole city into one `city.html`.

    Returns (path, reason). `path` is None when the city is too large to inline,
    because the two requirements -- opens by double-click, survives 50k files --
    genuinely cannot both hold: streaming needs fetch(), and file:// has no
    origin to fetch from.
    """
    import base64

    buildings = manifest["meta"]["buildingCount"]
    payload_paths: list[str] = ["city.json", "strings.bin"]
    for extra in ("index.json", "ext.bin", "bridges.json", "imports.json"):
        if os.path.exists(os.path.join(out_dir, extra)):
            payload_paths.append(extra)
    for subdir in ("d", "f"):
        directory = os.path.join(out_dir, subdir)
        if not os.path.isdir(directory):
            continue
        payload_paths.extend(
            f"{subdir}/{name}" for name in sorted(os.listdir(directory))
        )

    total = sum(os.path.getsize(os.path.join(out_dir, p)) for p in payload_paths)
    if buildings > SINGLE_FILE_MAX_BUILDINGS:
        return None, (
            f"{buildings:,} buildings exceeds the {SINGLE_FILE_MAX_BUILDINGS:,}-building "
            "limit for a single file; a single HTML document cannot stream, and inlining "
            "this city would mean parsing tens of megabytes before the first frame."
        )
    if total > SINGLE_FILE_MAX_BYTES:
        return None, (
            f"the city payload is {total / 1e6:.1f} MB, above the "
            f"{SINGLE_FILE_MAX_BYTES / 1e6:.0f} MB single-file limit (base64 inflates it "
            "by a further third)."
        )

    # Viewer modules, rewritten and registered under import-map keys. Walked as
    # a tree so `js/parts/*.js` is inlined under `zion/parts/*`, matching the
    # keys `_rewrite_module_specifiers` produces for nested imports.
    modules: dict[str, str] = {}
    js_root = os.path.join(out_dir, "js")
    for root, _dirs, files in os.walk(js_root):
        for name in sorted(files):
            if not name.endswith(".js"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, js_root)[:-3].replace(os.sep, "/")
            source = open(path, encoding="utf-8").read()
            modules[f"zion/{rel}"] = _data_url(
                _rewrite_module_specifiers(source, os.path.dirname(rel)).encode("utf-8")
            )

    three_path = os.path.join(out_dir, "vendor", "three.module.js")
    if os.path.exists(three_path):
        modules["three"] = _data_url(open(three_path, "rb").read())

    payload = {
        path: base64.b64encode(open(os.path.join(out_dir, path), "rb").read()).decode("ascii")
        for path in payload_paths
    }

    html = open(os.path.join(out_dir, "index.html"), encoding="utf-8").read()
    import json as _jsonlib

    importmap = '<script type="importmap">' + _jsonlib.dumps({"imports": modules}) + "</script>"
    # Replace the existing import map, and swap the external module for an
    # inline import of the inlined entry point.
    html = html.replace(
        '<script type="importmap">',
        "<!--ZION_IMPORTMAP-->",
        1,
    )
    start = html.find("<!--ZION_IMPORTMAP-->")
    end = html.find("</script>", start)
    html = html[:start] + importmap + html[end + len("</script>") :]
    # The entry point is a dynamic import so that module-graph failures are
    # reportable; the single-file build only has to repoint the specifier.
    html = html.replace("import('./js/main.js')", "import('zion/main')")
    html = html.replace(
        "<script type=\"module\">",
        "<script>window.__ZION_PAYLOAD__ = " + _jsonlib.dumps(payload) + ";</script>\n"
        '<script type="module">',
        1,
    )
    # The inlined build has no CSS file to fetch.
    css_path = os.path.join(out_dir, "css", "hud.css")
    if os.path.exists(css_path):
        css = open(css_path, encoding="utf-8").read()
        html = html.replace(
            '<link rel="stylesheet" href="./css/hud.css">',
            "<style>\n" + css + "\n</style>",
        )

    target = os.path.join(out_dir, "city.html")
    os.makedirs(os.path.dirname(target) or out_dir, exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(html)
    size = os.path.getsize(target)
    return target, f"inlined {len(payload)} payload files ({total / 1e6:.1f} MB raw) into {size / 1e6:.1f} MB"
