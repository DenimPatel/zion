"""District placement: treemap, streets, and building grids.

Districts are folders at an automatically chosen depth.  The depth rule exists
because the two reference repos have very different shapes: the small one has 4
useful districts at depth 1, while the large one has 11 districts at depth 1
(one of which holds 135 files), 21 at depth 2 (2-34 files each, none a single
building) and 269 at depth 3 (268 of them single-building).  Depth 2 is plainly
the right city for it, so the rule picks the *deepest* depth whose district count
lands in a readable band.

The treemap is a binary subdivision rather than a pure squarified layout, because
each split line is also where a street goes -- so the streets fall out of the
geometry instead of being drawn on top of it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .metrics import FileMetrics, RepoAnalysis

# District count band.  Below the minimum the city has no neighbourhoods; above
# the maximum it is a field of single-building districts.
MIN_DISTRICTS = 4
MAX_DISTRICTS = 64
MAX_DEPTH = 8

ROOT_DISTRICT = "(root)"

# World units are metres.
PLOT_AREA_PER_BUILDING = 900.0   # ~30 m x 30 m
STREET_WIDTH = 6.0
AVENUE_WIDTH = 11.0
BLOCK_INSET = 3.0


@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)


@dataclass
class PlacedBuilding:
    rel: str
    x: float
    y: float
    width: float
    depth: float
    height: float


@dataclass
class DistrictLayout:
    key: str
    name: str
    depth: int
    rect: Rect
    weight: float
    building_count: int
    has_readme: bool
    readme_rel: str = ""
    mayor: str = ""
    primary_language: str = ""
    logical_loc: int = 0
    documented: int = 0
    test_files: int = 0
    data_files: int = 0
    buildings: list[PlacedBuilding] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "depth": self.depth,
            "rect": [self.rect.x, self.rect.y, self.rect.w, self.rect.h],
            "weight": round(self.weight, 3),
            "buildings": self.building_count,
            "hasReadme": self.has_readme,
            "readmeRel": self.readme_rel,
            "mayor": self.mayor,
            "primaryLanguage": self.primary_language,
            "logicalLoc": self.logical_loc,
            "documented": self.documented,
            "testFiles": self.test_files,
            "dataFiles": self.data_files,
        }


@dataclass
class CityLayout:
    districts: list[DistrictLayout] = field(default_factory=list)
    streets: list[Rect] = field(default_factory=list)
    bounds: Rect = field(default_factory=lambda: Rect(0, 0, 0, 0))
    depth: int = 1

    def to_dict(self) -> dict:
        return {
            "depth": self.depth,
            "bounds": [self.bounds.x, self.bounds.y, self.bounds.w, self.bounds.h],
            "streets": [[s.x, s.y, s.w, s.h] for s in self.streets],
            "districts": [d.to_dict() for d in self.districts],
        }


# --------------------------------------------------------------------------
# District depth
# --------------------------------------------------------------------------


def district_key(rel: str, depth: int) -> str:
    """The file's directory, truncated to at most `depth` segments.

    Truncating the *directory* rather than the whole path matters: at depth 2 a
    file at ``alpha/main.py`` belongs to ``alpha``, not to a district named after
    itself, and not to the root district either.
    """
    parts = rel.split("/")
    directories = parts[:-1]
    if not directories:
        return ROOT_DISTRICT
    return "/".join(directories[:depth])


def district_counts(files: list[FileMetrics], max_depth: int = MAX_DEPTH) -> dict[int, int]:
    counts: dict[int, int] = {}
    for depth in range(1, max_depth + 1):
        keys = {district_key(f.rel, depth) for f in files}
        counts[depth] = len(keys)
    return counts


def _single_building_districts(files: list[FileMetrics], depth: int) -> int:
    sizes: dict[str, int] = {}
    for record in files:
        key = district_key(record.rel, depth)
        sizes[key] = sizes.get(key, 0) + 1
    return sum(1 for size in sizes.values() if size == 1)


def choose_depth(files: list[FileMetrics], max_depth: int = MAX_DEPTH) -> int:
    """Pick the depth with the most structure that still reads as a city.

    Among depths whose district count lands in the band, prefer those with no
    single-building district (a district of one is not a neighbourhood), then the
    highest count, breaking ties toward the shallowest depth.
    """
    if not files:
        return 1
    counts = district_counts(files, max_depth)
    in_band = {d: c for d, c in counts.items() if MIN_DISTRICTS <= c <= MAX_DISTRICTS}
    if in_band:
        no_singletons = [d for d in in_band if _single_building_districts(files, d) == 0]
        candidates = no_singletons or list(in_band)
        best = max(counts[d] for d in candidates)
        return min(d for d in candidates if counts[d] == best)

    def distance(item: tuple[int, int]) -> tuple[int, int]:
        depth, count = item
        gap = (MIN_DISTRICTS - count) if count < MIN_DISTRICTS else (count - MAX_DISTRICTS)
        return (gap, depth)

    return min(counts.items(), key=distance)[0]


# --------------------------------------------------------------------------
# Treemap with streets
# --------------------------------------------------------------------------


def _split_items(items: list[tuple[str, float]]) -> tuple[list, list]:
    """Split into two weight-balanced groups, preserving descending weight."""
    total = sum(w for _, w in items)
    running = 0.0
    cut = 1
    for i, (_, w) in enumerate(items):
        running += w
        if running >= total / 2.0:
            cut = min(max(1, i + 1), len(items) - 1)
            break
    return items[:cut], items[cut:]


def _treemap(
    items: list[tuple[str, float]],
    rect: Rect,
    out: dict[str, Rect],
    streets: list[Rect],
    depth: int = 0,
) -> None:
    if not items:
        return
    if len(items) == 1:
        out[items[0][0]] = rect
        return

    total = sum(w for _, w in items)
    if total <= 0:
        total = float(len(items))
        items = [(k, 1.0) for k, _ in items]

    first, second = _split_items(items)
    first_total = sum(w for _, w in first)
    fraction = first_total / total
    fraction = min(0.88, max(0.12, fraction))

    # Split the longer axis so districts stay roughly square.
    if rect.w >= rect.h:
        gap = STREET_WIDTH if depth > 0 else AVENUE_WIDTH
        usable = max(1.0, rect.w - gap)
        first_w = usable * fraction
        r1 = Rect(rect.x, rect.y, first_w, rect.h)
        r2 = Rect(rect.x + first_w + gap, rect.y, usable - first_w, rect.h)
        streets.append(Rect(rect.x + first_w, rect.y, gap, rect.h))
    else:
        gap = STREET_WIDTH if depth > 0 else AVENUE_WIDTH
        usable = max(1.0, rect.h - gap)
        first_h = usable * fraction
        r1 = Rect(rect.x, rect.y, rect.w, first_h)
        r2 = Rect(rect.x, rect.y + first_h + gap, rect.w, usable - first_h)
        streets.append(Rect(rect.x, rect.y + first_h, rect.w, gap))

    _treemap(first, r1, out, streets, depth + 1)
    _treemap(second, r2, out, streets, depth + 1)


def _grid_for(rect: Rect, count: int) -> tuple[int, int, float, float]:
    """Choose a column/row grid for `count` buildings inside `rect`."""
    if count <= 0:
        return 0, 0, 0.0, 0.0
    inner_w = max(1.0, rect.w - 2 * BLOCK_INSET)
    inner_h = max(1.0, rect.h - 2 * BLOCK_INSET)
    aspect = inner_w / inner_h if inner_h else 1.0
    cols = max(1, int(round(math.sqrt(count * aspect))))
    rows = max(1, math.ceil(count / cols))
    while cols * rows < count:
        rows += 1
    return cols, rows, inner_w / cols, inner_h / rows


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------


def build_layout(analysis: RepoAnalysis, depth: int | None = None) -> CityLayout:
    files = analysis.files
    layout = CityLayout()
    if not files:
        return layout

    chosen = depth if depth is not None else choose_depth(files)
    layout.depth = chosen

    grouped: dict[str, list[FileMetrics]] = {}
    for record in files:
        grouped.setdefault(district_key(record.rel, chosen), []).append(record)

    for key, members in grouped.items():
        members.sort(key=lambda f: f.rel)
        for record in members:
            record.district = key

    entries = sorted(
        ((key, sum(max(1e-6, f.weight) for f in members)) for key, members in grouped.items()),
        key=lambda kv: -kv[1],
    )

    total_weight = sum(w for _, w in entries)
    city_area = max(PLOT_AREA_PER_BUILDING * len(files), total_weight)
    side = max(60.0, math.sqrt(city_area))
    root = Rect(0.0, 0.0, side, side)

    rects: dict[str, Rect] = {}
    streets: list[Rect] = []
    _treemap(entries, root, rects, streets)

    for key, members in grouped.items():
        rect = rects.get(key, Rect(0, 0, 0, 0))
        block = inset(rect, BLOCK_INSET)
        cols, rows, cell_w, cell_h = _grid_for(block, len(members))

        district = DistrictLayout(
            key=key,
            # Display name is the last path segment; the full key is the path.
            name=key if key == ROOT_DISTRICT else key.rsplit("/", 1)[-1],
            depth=chosen,
            rect=rect,
            weight=sum(max(1e-6, f.weight) for f in members),
            building_count=len(members),
            has_readme=any(f.is_doc for f in members),
            readme_rel=next((f.rel for f in members if f.is_doc), ""),
            primary_language=_primary_language(members),
            logical_loc=sum(f.logical_loc for f in members),
            documented=sum(1 for f in members if f.doc_ratio >= 0.1),
            test_files=sum(1 for f in members if f.is_test),
            data_files=sum(1 for f in members if f.rows is not None),
        )
        if analysis.flags.authorship:
            district.mayor = _mayor(members)

        for index, record in enumerate(members):
            col = index % cols if cols else 0
            row = index // cols if cols else 0
            cell_x = block.x + col * cell_w
            cell_y = block.y + row * cell_h
            # Keep a visible gap between neighbours so the grid reads as plots.
            gap = min(2.0, cell_w * 0.18, cell_h * 0.18)
            width = max(2.5, min(record.footprint, cell_w - gap))
            depth_m = max(2.5, min(record.footprint, cell_h - gap))
            district.buildings.append(
                PlacedBuilding(
                    rel=record.rel,
                    x=cell_x + (cell_w - width) / 2.0,
                    y=cell_y + (cell_h - depth_m) / 2.0,
                    width=width,
                    depth=depth_m,
                    height=max(2.0, record.height),
                )
            )
        layout.districts.append(district)

    layout.districts.sort(key=lambda d: (-d.weight, d.key))
    layout.streets = [s for s in streets if s.w > 0.1 and s.h > 0.1]
    layout.bounds = Rect(0.0, 0.0, side, side)
    return layout


def inset(rect: Rect, amount: float) -> Rect:
    return Rect(
        rect.x + amount,
        rect.y + amount,
        max(1.0, rect.w - 2 * amount),
        max(1.0, rect.h - 2 * amount),
    )


def _primary_language(members: list[FileMetrics]) -> str:
    counts: dict[str, int] = {}
    for record in members:
        counts[record.language] = counts.get(record.language, 0) + max(1, record.logical_loc)
    if not counts:
        return ""
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _mayor(members: list[FileMetrics]) -> str:
    totals: dict[str, int] = {}
    for record in members:
        for author, lines in record.authors.items():
            totals[author] = totals.get(author, 0) + lines
    if not totals:
        return ""
    return max(totals.items(), key=lambda kv: kv[1])[0]
