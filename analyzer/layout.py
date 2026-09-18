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
MAX_DISTRICTS_SMALL = 64
MAX_DISTRICTS_LARGE = 400
LARGE_REPO_FILES = 5000
MAX_DEPTH = 8


def district_band(file_count: int) -> tuple[int, int]:
    """Readable district-count band, scaled to the size of the repo.

    A fixed ceiling would describe a 50,000-file repository with eight enormous
    districts, even though its folder tree plainly offers hundreds of
    neighbourhoods.
    """
    if file_count > LARGE_REPO_FILES:
        return MIN_DISTRICTS, MAX_DISTRICTS_LARGE
    return MIN_DISTRICTS, MAX_DISTRICTS_SMALL

ROOT_DISTRICT = "(root)"

# World units are metres.
PLOT_AREA_PER_BUILDING = 900.0   # ~30 m x 30 m
PLOT_GAP = 2.0                   # kept clear between neighbouring plots
STREET_WIDTH = 6.0
AVENUE_WIDTH = 11.0
BLOCK_INSET = 3.0

# City Hall stands on ground no district may build on.  The hall is scaled to the
# skyline, but the plaza has to stay a plaza: if it grew with the tallest building
# a small repository would be nothing but forecourt, so the reserve is capped as a
# share of the plan and the hall is scaled back to fit whatever is left.
CITY_HALL_PLAZA_MARGIN = 3.0
CITY_HALL_MAX_HALF_SHARE = 0.16
CITY_HALL_MIN_SCALE = 0.3        # absolute floor, for a plan of almost nothing
CITY_HALL_MAX_SCALE = 4.5
CITY_HALL_BASE_SCALE = 1.6
CITY_HALL_PLAZA_RADIUS = 26.0   # per unit of hall scale; mirrored by the viewer
CITY_HALL_HEIGHT_DIVISOR = 34.0


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
    # Ground reserved for City Hall. Empty until build_layout runs; districts are
    # never placed on it, which is what keeps the landmark out of the skyline.
    plaza: Rect | None = None
    hall_scale: float = 0.0

    def city_hall(self) -> dict | None:
        """Where the landmark stands and how big it is.

        Emitted so the viewer never has to re-derive the hall's size: the reserve
        and the massing have to agree, and the only way to guarantee that is for
        one side to compute both.
        """
        if self.plaza is None or self.hall_scale <= 0:
            return None
        scale = self.hall_scale
        cx = self.plaza.cx
        cz = self.plaza.cy
        return {
            "centre": [round(cx, 3), round(cz, 3)],
            "scale": round(scale, 4),
            "plazaRadius": round(CITY_HALL_PLAZA_RADIUS * scale, 3),
            "plaza": [
                round(self.plaza.x, 3),
                round(self.plaza.y, 3),
                round(self.plaza.w, 3),
                round(self.plaza.h, 3),
            ],
            # The hall's own collision box: 30 x 20 at scale, matching the
            # viewer's massing, so walk mode cannot stand inside it.
            "footprint": [
                round(cx - 15 * scale, 3),
                round(cz - 10 * scale, 3),
                round(30 * scale, 3),
                round(20 * scale, 3),
            ],
        }

    def to_dict(self) -> dict:
        return {
            "depth": self.depth,
            "bounds": [self.bounds.x, self.bounds.y, self.bounds.w, self.bounds.h],
            "streets": [[s.x, s.y, s.w, s.h] for s in self.streets],
            "districts": [d.to_dict() for d in self.districts],
            "cityHall": self.city_hall(),
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
    low, high = district_band(len(files))
    in_band = {d: c for d, c in counts.items() if low <= c <= high}
    if in_band:
        no_singletons = [d for d in in_band if _single_building_districts(files, d) == 0]
        candidates = no_singletons or list(in_band)
        best = max(counts[d] for d in candidates)
        return min(d for d in candidates if counts[d] == best)

    low, high = district_band(len(files))

    def distance(item: tuple[int, int]) -> tuple[int, int]:
        depth, count = item
        gap = (low - count) if count < low else (count - high)
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


def _city_hall_scale(side: float, max_height: float) -> float:
    """How big City Hall may be, given the plan it has to stand on.

    The viewer scales the hall from the skyline, but a plaza that grew without
    limit would swallow a small repository whole -- the tallest building in a
    160 m plan would raise a landmark wider than the city. So the reserve is
    capped as a share of the plan and the hall is scaled down to whatever fits,
    with an absolute floor for a plan that is barely a plan at all.
    """
    base = min(
        CITY_HALL_MAX_SCALE,
        max(CITY_HALL_BASE_SCALE, max_height / CITY_HALL_HEIGHT_DIVISOR),
    )
    capped_half = CITY_HALL_MAX_HALF_SHARE * side
    fitted = (capped_half - CITY_HALL_PLAZA_MARGIN) / CITY_HALL_PLAZA_RADIUS
    return max(CITY_HALL_MIN_SCALE, min(base, fitted))


def _reserve(rect: Rect, plaza: Rect, gap: float = AVENUE_WIDTH) -> Rect:
    """The plaza plus the avenue that rings it, which districts must leave clear."""
    return Rect(plaza.x - gap, plaza.y - gap, plaza.w + 2 * gap, plaza.h + 2 * gap)


def _frame_around(rect: Rect, plaza: Rect, gap: float = AVENUE_WIDTH) -> list[Rect]:
    """The four bands of `rect` that surround the reserve, leaving it clear.

    A treemap covers whatever rectangle it is given, so reserving ground for the
    landmark means never handing it the middle of the plan: the districts are laid
    out in a frame instead, and the hole is where City Hall stands. The bands tile
    the plan minus the reserve exactly once, so no district is lost and none
    overlaps the landmark.
    """
    reserve = _reserve(rect, plaza, gap)
    bands = [
        Rect(rect.x, rect.y, rect.w, reserve.y - rect.y),                                  # top
        Rect(rect.x, reserve.y + reserve.h, rect.w, rect.y + rect.h - (reserve.y + reserve.h)),  # bottom
        Rect(rect.x, reserve.y, reserve.x - rect.x, reserve.h),                            # left
        Rect(reserve.x + reserve.w, reserve.y, rect.x + rect.w - (reserve.x + reserve.w), reserve.h),  # right
    ]
    return [b for b in bands if b.w > 1.0 and b.h > 1.0]


def _streets_around(rect: Rect, plaza: Rect, gap: float = AVENUE_WIDTH) -> list[Rect]:
    """The avenue ring around City Hall, and the seams where the bands meet.

    The frame leaves the districts touching along the reserve's edges; a street
    down each seam is what keeps two neighbourhoods from sharing a party wall.
    Seams are centred on the boundary, which is ground the plot inset already
    keeps clear of buildings.
    """
    reserve = _reserve(rect, plaza, gap)
    seam = STREET_WIDTH
    half = seam / 2.0
    right_x = reserve.x + reserve.w
    bottom_y = reserve.y + reserve.h
    return [
        # The ring: City Hall is approached from an avenue, not from a back alley.
        Rect(reserve.x, reserve.y, reserve.w, gap),
        Rect(reserve.x, bottom_y - gap, reserve.w, gap),
        Rect(reserve.x, reserve.y + gap, gap, reserve.h - 2 * gap),
        Rect(right_x - gap, reserve.y + gap, gap, reserve.h - 2 * gap),
        # The seams, outside the reserve, where the four bands meet.
        Rect(rect.x, reserve.y - half, reserve.x - rect.x, seam),
        Rect(right_x, reserve.y - half, rect.x + rect.w - right_x, seam),
        Rect(rect.x, bottom_y - half, reserve.x - rect.x, seam),
        Rect(right_x, bottom_y - half, rect.x + rect.w - right_x, seam),
    ]


def _spread_over_bands(entries: list[tuple[str, float]], bands: list[Rect]) -> list[list]:
    """Deal districts into the frame, heaviest first, into the roomiest band.

    Districts keep their descending weight, so each band receives a contiguous
    run of the ordering and its own treemap subdivides that run normally.
    """
    if not bands:
        return []
    total = sum(w for _, w in entries) or 1.0
    areas = [max(1.0, b.w * b.h) for b in bands]
    area_total = sum(areas)
    room = [total * a / area_total for a in areas]
    groups: list[list] = [[] for _ in bands]
    for key, weight in entries:
        target = max(range(len(bands)), key=lambda i: room[i])
        groups[target].append((key, weight))
        room[target] -= weight
    return groups


def plan_dims(record) -> tuple[float, float]:
    """A file's plot as (long side, short side) in metres.

    Records built before footprints had two dimensions -- and any the parser
    could describe no floor plan for -- fall back to a square off `footprint`.
    """
    width = getattr(record, "footprint_w", 0.0) or record.footprint
    depth = getattr(record, "footprint_d", 0.0) or record.footprint
    return max(width, depth), min(width, depth)


def plot_demand(record) -> float:
    """Ground a file's plot needs, gap included, in square metres."""
    long_side, short_side = plan_dims(record)
    return (long_side + PLOT_GAP) * (short_side + PLOT_GAP)


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

    # District area is folder content weight -- but never less than the ground
    # its buildings actually need.
    #
    # Without that floor, a folder of two hundred small files gets a rect sized
    # by its line count, the per-building cells come out a few metres across,
    # and every footprint is clipped to the cell: which is exactly how a
    # repository ended up as a field of identical squares regardless of what
    # `footprint_for` computed. Both terms are already in square metres, so the
    # floor is a plain max.
    def district_weight(members: list[FileMetrics]) -> float:
        content = sum(max(1e-6, f.weight) for f in members)
        return max(content, sum(plot_demand(f) for f in members))

    weights = {key: district_weight(members) for key, members in grouped.items()}
    entries = sorted(weights.items(), key=lambda kv: -kv[1])

    total_weight = sum(w for _, w in entries)
    city_area = max(PLOT_AREA_PER_BUILDING * len(files), total_weight)
    side = max(60.0, math.sqrt(city_area))
    root = Rect(0.0, 0.0, side, side)

    # Reserve the middle of the plan before any district is placed, so the
    # landmark is ground nobody builds on rather than a building dropped into
    # somebody's block.
    scale = _city_hall_scale(side, max((f.height for f in files), default=0.0))
    plaza_half = CITY_HALL_PLAZA_RADIUS * scale + CITY_HALL_PLAZA_MARGIN
    plaza = Rect(
        side / 2.0 - plaza_half,
        side / 2.0 - plaza_half,
        2.0 * plaza_half,
        2.0 * plaza_half,
    )
    layout.plaza = plaza
    layout.hall_scale = scale

    rects: dict[str, Rect] = {}
    streets: list[Rect] = []
    # The reserve is capped so the four bands always survive, which is what the
    # layout test pins down for plan sizes from 60 m to 3.2 km.
    bands = _frame_around(root, plaza)
    layout.plaza = plaza
    layout.hall_scale = scale
    streets.extend(_streets_around(root, plaza))
    for band, group in zip(bands, _spread_over_bands(entries, bands)):
        _treemap(group, band, rects, streets)

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
            weight=weights[key],
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

        # Keep a visible gap between neighbours so the grid reads as plots.
        gap = min(PLOT_GAP, cell_w * 0.18, cell_h * 0.18)
        landscape = cell_w >= cell_h
        avail_long = max(1.0, max(cell_w, cell_h) - gap)
        avail_short = max(1.0, min(cell_w, cell_h) - gap)

        # One scale for the district, not a clamp per building.
        #
        # Clipping each plot to its cell independently destroyed exactly the
        # information the footprint carried: every building big enough to hit
        # the cell came out the same size as every other, which in a dense
        # district is most of them. Scaling the whole block by a single factor
        # keeps every plot's size *relative to its neighbours* intact, which is
        # the part that can actually be read.
        #
        # The factor fits nine plots in ten rather than all of them, because
        # taking the minimum lets one 3,000-line outlier shrink its three
        # thousand neighbours to specks. The few that still overflow are
        # clipped to their lot below, with their proportions kept.
        needs = sorted(
            min(avail_long / long_side, avail_short / short_side)
            for long_side, short_side in (plan_dims(record) for record in members)
        )
        fit = min(1.0, needs[max(0, math.ceil(0.9 * len(needs)) - 1)])

        for index, record in enumerate(members):
            col = index % cols if cols else 0
            row = index // cols if cols else 0
            cell_x = block.x + col * cell_w
            cell_y = block.y + row * cell_h
            long_side, short_side = plan_dims(record)
            # A slab lies along its plot rather than across it, the way a plan
            # turns a long building to fit its lot.
            plan_w = long_side if landscape else short_side
            plan_d = short_side if landscape else long_side
            width = plan_w * fit
            depth_m = plan_d * fit
            # An oversized plot is trimmed to its lot, not squared off: both
            # sides come down together so the building keeps its proportions.
            over = max(1.0, width / (cell_w - gap), depth_m / (cell_h - gap))
            width = max(1.5, width / over)
            depth_m = max(1.5, depth_m / over)
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
