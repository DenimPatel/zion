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

The treemap is also *nested*: districts are grouped by their folder path, each
folder that actually splits into more than one piece becomes a region on its
own raised plinth, and the roads between siblings narrow with depth --
highways between top-level folders, then avenues, streets and alleys. A road's
width is therefore how far apart two neighbourhoods are in the folder tree.
Folders with a single child pass their ground straight through (no road, no
plinth), so a `src/main/java/com/acme` chain costs nothing.
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

# Road classes, by how far up the folder tree two neighbours part company.
# Index = class id emitted with each street: 0 highway, 1 avenue, 2 street,
# 3 alley. Widths are for a full-size city; small plans scale them down (see
# `_road_scale`) so a 60 m repository is not all tarmac.
ROAD_HIGHWAY, ROAD_AVENUE, ROAD_STREET, ROAD_ALLEY = 0, 1, 2, 3
ROAD_WIDTHS = (14.0, 9.0, 5.5, 3.0)
ROAD_NAMES = ("highway", "avenue", "street", "alley")
ROAD_SCALE_MIN = 0.55
ROAD_SCALE_SIDE = 300.0
REGION_INSET = 1.5               # plinth edge left showing inside each region

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
class Street(Rect):
    """A strip of road; `cls` is its road class (0 highway .. 3 alley)."""

    cls: int = ROAD_STREET


@dataclass
class Region:
    """A folder that splits into more than one piece: a raised plinth.

    `level` is 1 for a top-level region and grows inward; `parent` is the key
    of the enclosing region, or "" at the top. Leaf districts are not regions.
    """

    key: str
    name: str
    level: int
    rect: Rect
    parent: str = ""
    districts: int = 0
    buildings: int = 0
    logical_loc: int = 0


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
    # Nesting: how many regions enclose this district, and the innermost one.
    level: int = 0
    region: str = ""
    # Architect's aggregates (analyzer/health.py signals summed per district).
    contributors: int = 0
    bus_factor: int = 0
    hotspots: int = 0
    oversized: int = 0
    orphans: int = 0
    knowledge_risks: int = 0
    cycles: int = 0
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
            "level": self.level,
            "region": self.region,
        }


@dataclass
class CityLayout:
    districts: list[DistrictLayout] = field(default_factory=list)
    streets: list[Street] = field(default_factory=list)
    regions: list[Region] = field(default_factory=list)
    road_widths: tuple[float, ...] = ROAD_WIDTHS
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
            "streets": [[s.x, s.y, s.w, s.h, s.cls] for s in self.streets],
            "regions": [
                {"key": r.key, "name": r.name, "level": r.level, "parent": r.parent,
                 "rect": [r.rect.x, r.rect.y, r.rect.w, r.rect.h]}
                for r in self.regions
            ],
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
    streets: list[Street],
    gap: float = STREET_WIDTH,
    cls: int = ROAD_STREET,
) -> None:
    """Binary weight-balanced split of `rect` among `items`.

    Every cut between these siblings is the same class of road: siblings are
    equally far apart in the folder tree, whichever cut separates them.
    """
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
        usable = max(1.0, rect.w - gap)
        first_w = usable * fraction
        r1 = Rect(rect.x, rect.y, first_w, rect.h)
        r2 = Rect(rect.x + first_w + gap, rect.y, usable - first_w, rect.h)
        streets.append(Street(rect.x + first_w, rect.y, gap, rect.h, cls))
    else:
        usable = max(1.0, rect.h - gap)
        first_h = usable * fraction
        r1 = Rect(rect.x, rect.y, rect.w, first_h)
        r2 = Rect(rect.x, rect.y + first_h + gap, rect.w, usable - first_h)
        streets.append(Street(rect.x, rect.y + first_h, rect.w, gap, cls))

    _treemap(first, r1, out, streets, gap, cls)
    _treemap(second, r2, out, streets, gap, cls)


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


def _frame_around(rect: Rect, plaza: Rect, gap: float = AVENUE_WIDTH, seam: float = 0.0) -> list[Rect]:
    """The four bands of `rect` that surround the reserve, leaving it clear.

    A treemap covers whatever rectangle it is given, so reserving ground for the
    landmark means never handing it the middle of the plan: the districts are laid
    out in a frame instead, and the hole is where City Hall stands. The bands tile
    the plan minus the reserve exactly once, so no district is lost and none
    overlaps the landmark.

    With a `seam`, each band also gives up half a road's width along every edge
    it shares with another band, so the road down the seam is real ground rather
    than a strip painted over somebody's plot.
    """
    reserve = _reserve(rect, plaza, gap)
    half = seam / 2.0
    bands = [
        Rect(rect.x, rect.y, rect.w, reserve.y - rect.y - half),                                   # top
        Rect(rect.x, reserve.y + reserve.h + half, rect.w,
             rect.y + rect.h - (reserve.y + reserve.h) - half),                                      # bottom
        Rect(rect.x, reserve.y + half, reserve.x - rect.x, reserve.h - seam),                       # left
        Rect(reserve.x + reserve.w, reserve.y + half,
             rect.x + rect.w - (reserve.x + reserve.w), reserve.h - seam),                           # right
    ]
    return [b for b in bands if b.w > 1.0 and b.h > 1.0]


def _streets_around(rect: Rect, plaza: Rect, gap: float = AVENUE_WIDTH, seam: float = STREET_WIDTH) -> list[Street]:
    """The ring road around City Hall, and the seams where the bands meet.

    The ring and the seams are highways: they are what every top-level
    neighbourhood is reached from. Seams are centred on the band boundaries,
    which `_frame_around` leaves clear when given the same `seam`.
    """
    reserve = _reserve(rect, plaza, gap)
    half = seam / 2.0
    right_x = reserve.x + reserve.w
    bottom_y = reserve.y + reserve.h
    cls = ROAD_HIGHWAY
    return [
        # The ring: City Hall is approached from the ring road, not a back alley.
        Street(reserve.x, reserve.y, reserve.w, gap, cls),
        Street(reserve.x, bottom_y - gap, reserve.w, gap, cls),
        Street(reserve.x, reserve.y + gap, gap, reserve.h - 2 * gap, cls),
        Street(right_x - gap, reserve.y + gap, gap, reserve.h - 2 * gap, cls),
        # The seams, outside the reserve, where the four bands meet.
        Street(rect.x, reserve.y - half, reserve.x - rect.x, seam, cls),
        Street(right_x, reserve.y - half, rect.x + rect.w - right_x, seam, cls),
        Street(rect.x, bottom_y - half, reserve.x - rect.x, seam, cls),
        Street(right_x, bottom_y - half, rect.x + rect.w - right_x, seam, cls),
        # Shoulders between the ring and the bands above and below it.
        Street(reserve.x, reserve.y - half, reserve.w, half, cls),
        Street(reserve.x, bottom_y, reserve.w, half, cls),
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
    tree = _folder_tree(weights)
    top = _collapse(tree)

    total_weight = sum(weights.values())
    base_area = max(PLOT_AREA_PER_BUILDING * len(files), total_weight)
    road_scale = _road_scale(math.sqrt(base_area))
    widths = tuple(w * road_scale for w in ROAD_WIDTHS)
    layout.road_widths = widths
    # Roads and plinth edges are ground too: allow for them up front so the
    # nesting does not quietly shrink every building to pay for its streets.
    city_area = base_area + _road_allowance(top, base_area, total_weight, widths)
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
    streets: list[Street] = []
    highway = widths[ROAD_HIGHWAY]
    # The reserve is capped so the four bands always survive, which is what the
    # layout test pins down for plan sizes from 60 m to 3.2 km. The frame and
    # the plaza are worked out once, over the top-level folders only; nesting
    # happens inside each top-level folder's own ground.
    bands = _frame_around(root, plaza, highway, seam=highway)
    streets.extend(_streets_around(root, plaza, highway, seam=highway))
    top_items = [top] if top.leaf else top.children
    top_entries = [(child.id, child.weight) for child in top_items]
    by_id = {child.id: child for child in top_items}
    placed: dict[str, Rect] = {}
    for band, group in zip(bands, _spread_over_bands(top_entries, bands)):
        _treemap(group, band, placed, streets, highway, ROAD_HIGHWAY)
    district_level: dict[str, tuple[int, str]] = {}
    for item_id, rect in placed.items():
        _place_node(by_id[item_id], rect, 1, "", rects, streets, layout.regions, district_level, widths)

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
            level=district_level.get(key, (0, ""))[0],
            region=district_level.get(key, (0, ""))[1],
        )
        if analysis.flags.authorship:
            district.mayor = _mayor(members)
        _district_health(district, members)

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
    _region_totals(layout)
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


# --------------------------------------------------------------------------
# Folder tree: regions and road classes
# --------------------------------------------------------------------------


@dataclass
class _Node:
    """One item in a nested treemap: a leaf district or a folder of items.

    `id` is the treemap key -- a district key for a leaf, and the folder path
    prefixed with a slash for a folder (a folder and the district of its own
    loose files can share a path, and must not share a key).
    """

    id: str
    path: str
    weight: float = 0.0
    leaf: bool = False
    children: list["_Node"] = field(default_factory=list)


def _folder_tree(weights: dict[str, float]) -> _Node:
    """Group leaf districts by their folder path, one node per prefix."""
    root = _Node(id="/", path="")
    folders: dict[str, _Node] = {"": root}

    def folder(path: str) -> _Node:
        node = folders.get(path)
        if node is None:
            parent_path = path.rsplit("/", 1)[0] if "/" in path else ""
            node = _Node(id="/" + path, path=path)
            folders[path] = node
            folder(parent_path).children.append(node)
        return node

    for key in sorted(weights):
        parent = "" if key == ROOT_DISTRICT else key
        # A district's own files are a leaf *inside* its folder when that folder
        # also has sub-folders; `_collapse` folds the folder away otherwise.
        folder(parent).children.append(_Node(id=key, path=key, weight=weights[key], leaf=True))

    def total(node: _Node) -> float:
        if not node.leaf:
            node.weight = sum(total(child) for child in node.children)
            node.children.sort(key=lambda n: (-n.weight, n.id))
        return node.weight

    total(root)
    return root


def _collapse(node: _Node) -> _Node:
    """Follow single-child folders down to the first real split (or a leaf)."""
    while not node.leaf and len(node.children) == 1:
        node = node.children[0]
    return node


def _road_scale(side: float) -> float:
    return max(ROAD_SCALE_MIN, min(1.0, side / ROAD_SCALE_SIDE))


def _road_class(level: int) -> int:
    return min(ROAD_ALLEY, level)


def _road_allowance(top: _Node, area: float, total_weight: float, widths: tuple[float, ...]) -> float:
    """Rough ground the roads and plinth edges will take, in square metres.

    Each split in a folder with k children lays k-1 roads about as long as the
    folder is wide; each region also gives up an inset ring. Estimated from the
    folder's share of the plan, which is all that is known before layout.
    """
    total_weight = total_weight or 1.0
    allowance = 0.0

    def visit(node: _Node, level: int) -> None:
        nonlocal allowance
        if node.leaf:
            return
        span = math.sqrt(max(1.0, area * node.weight / total_weight))
        gap = widths[_road_class(level - 1)] if level else widths[ROAD_HIGHWAY]
        allowance += max(0, len(node.children) - 1) * gap * span
        if level:
            allowance += 4.0 * span * REGION_INSET
        for child in node.children:
            visit(_collapse(child), level + 1)

    visit(top, 0)
    return allowance


def _place_node(
    node: _Node,
    rect: Rect,
    level: int,
    parent: str,
    rects: dict[str, Rect],
    streets: list[Street],
    regions: list[Region],
    district_level: dict[str, tuple[int, str]],
    widths: tuple[float, ...],
) -> None:
    """Give `node` its ground: a leaf keeps it, a folder becomes a region."""
    node = _collapse(node)
    if node.leaf:
        rects[node.id] = rect
        district_level[node.id] = (level - 1, parent)
        return
    name = node.path[len(parent) + 1:] if parent and node.path.startswith(parent + "/") else node.path
    regions.append(Region(key=node.path, name=name, level=level, rect=rect, parent=parent))
    inner = inset(rect, REGION_INSET)
    cls = _road_class(level)
    placed: dict[str, Rect] = {}
    _treemap([(c.id, c.weight) for c in node.children], inner, placed, streets, widths[cls], cls)
    by_id = {c.id: c for c in node.children}
    for item_id, child_rect in placed.items():
        _place_node(by_id[item_id], child_rect, level + 1, node.path, rects, streets, regions, district_level, widths)


def _district_health(district: DistrictLayout, members: list[FileMetrics]) -> None:
    """Sum each file's architect's signals into the district's."""
    from .health import bus_factor

    lines: dict[str, int] = {}
    for record in members:
        for author, added in record.authors.items():
            lines[author] = lines.get(author, 0) + added
    district.contributors = len(lines)
    district.bus_factor = bus_factor(lines) if lines else 0
    district.hotspots = sum(1 for f in members if f.is_hotspot)
    district.oversized = sum(1 for f in members if f.is_oversized)
    district.orphans = sum(1 for f in members if f.is_orphan)
    district.knowledge_risks = sum(1 for f in members if f.knowledge_risk)
    district.cycles = len({f.cycle_id for f in members if f.cycle_id})


def _region_totals(layout: CityLayout) -> None:
    """Count districts, buildings and lines under every region."""
    by_key = {r.key: r for r in layout.regions}
    for district in layout.districts:
        key = district.region
        while key and key in by_key:
            region = by_key[key]
            region.districts += 1
            region.buildings += district.building_count
            region.logical_loc += district.logical_loc
            key = region.parent
