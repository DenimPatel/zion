# Visualization roadmap: reading more of a repo from the skyline alone

## Implementation status
Phases 0–3, and the cheap/high-value parts of Phase 4, have since been implemented on
`claude/city-repo-visualization-5293bc` (S1–S6, S8, S9's data + entrypoint marker, S10's complexity
data, S12, S13's metadata-only "first version", S14, S15–S18, S19's report view). What follows is a
plain status per item; the rest of this document is the original plan and is kept as-is below.

| Item | Status |
|---|---|
| S1 age, S2 scaffolding, S3 era, S4 heat, S5 district heat | **Shipped** |
| S6 co-change pairs | **Shipped, revised**: originally drawn as an arc ("skybridge") between every resident pair, which at any real building count read as an unlabelled tangle with no way to tell one pair from another and was removed on user feedback. The data (`bridges.json`) and degeneration rule are unchanged; it now surfaces only as a named, clickable "Changes together with" list in a building's detail report (`viewer/js/detail.js`) |
| rooftop beacon (part of S4) | **Shipped** (was missing entirely before this revision — the legend promised it, nothing drew it; now a 3-tier graded beacon, separate from the crane which still marks only the top decile) |
| S8 downtown/centrality | **Shipped** (import resolution is best-effort: exact-ish for Python via `ast`, a relative-path regex for JS/TS) |
| S9 floors that mean something | **Partly shipped**: entrypoint marker and complexity are computed and shown in the detail report; floor-band tinting inside the 3D interior itself is not done |
| S10 complexity bracing | **Data only**: `Floor.complexity` is computed and shown in the detail report; the 3D cross-bracing geometry on the facade is not built |
| S11 underground utilities | **Not implemented** — needs the import edge list (only in-degree counts were kept) plus a new toggle and tunnel geometry; real remaining work |
| S12 bus-factor-1 | **Shipped** |
| S13 nested districts | **Shipped**: `analyzer/layout.py` lays the leaf districts (same keys, same members, same chunks) out as a nested treemap over their folder tree. Every folder that splits becomes a region (`manifest.regions`, drawn as a raised plinth one step per level), roads carry a class (`streets[i][4]`: highway → avenue → street → alley) by how far apart the folders they separate are, and single-child folder chains collapse. The plaza, frame and band spreading still run once over the top-level folders; the 60 m–3.2 km plan-size test passes unmodified, and `tests/test_nesting.py` pins leaf identity, region nesting, road narrowing and "no building on a road". Region and district names are drawn on the map by camera distance (`viewer/js/labels.js`) |
| S14 drill-down/breadcrumb | **Shipped** as a breadcrumb + clickable sub-folder narrowing in the inspector/detail report, plus clickable region plinths with their own folder report (`Inspector.showRegion`); a fade-outside-the-region effect is not built |
| Architect's signals (new) | **Shipped**: `analyzer/health.py` — hotspots (commit frequency × size), oversized files, orphan candidates, import cycles (Tarjan over the resolved import edges `_finalize_downtown` now keeps), knowledge risk (main owner inactive 6+ months), first author / last editor / bus factor. Drawn as hazard barriers, raking shores, boarded-up fronts, cycle pennants and a red corner flag; listed in the City Guide's Health tab and the manifest's `review` block; a `health` colour lens. Vendored code is excluded |
| S15 facet index, S16 filter bar, S17 colour lens, S18 chips | **Shipped** |
| S19 detail window | **Shipped as a report**, not a second orbiting 3D render of the selected building — a text/table report with metrics, floors, activity, co-changed files and (for a district) sub-folders and largest files. The lasso/rectangle-select extension in overview mode is not built |
| S7 time-lapse | **Not implemented** — the monthly `activity` data it needs exists (S4), but the scrub slider and per-instance appear-at-birth animation are not built |

**Why the gaps**: this session has no browser, so nothing in `viewer/` could be verified visually —
every shipped viewer change was checked with `node --check` (syntax) and by tracing it against an
existing, already-correct pattern in the same file (e.g. new instanced props mirror `_addRoofProps`;
new colour lenses mirror `highlightDistrict`'s revertible-`baseColors` technique). S11, S7 and the full
S13 re-layout are each a genuinely new interactive mechanism (a toggle-driven tunnel view, a frame-loop
animation driven by a new slider, a recursive rewrite of `build_layout`'s treemap) that would be
irresponsible to ship unverified at that level of novelty. They remain accurately described below as
not-yet-built, with everything the next session needs to build them.

This is a plan, not shipped functionality. Nothing in this document changes the analyzer, the layout,
the emitter, or the viewer. It exists so an implementing agent (or the next session) can pick up any
item and build it without re-deriving the codebase first.

The goal it serves: today Zion answers *"which folders have no README?"*, *"which files are huge and
undocumented?"* and *"who owns this part of the codebase?"* by reading the skyline. The next layer of
questions is about **change over time and structure across the whole repo without opening a file**:
which files are new vs. old, which are hot vs. stable, which sector is under active development, is
there a "downtown", how do nested folders read, how do you slice/filter/count ("how many `README.md` /
`CLAUDE.md` / `.py` files are there?"), and how do you go from "the skyline" to "everything about this
one building or district" without losing the analogy.

Every item below must pass the project's own rule: **"Everything in the city is one of these, and
nothing is decoration"** (README.md, "The legend"). A visualization only belongs here if it completes
the sentence *"X looks like Y because Z"* with a real Z drawn from repo data.

---

## Current state & gaps

Facts about the existing pipeline that shape everything below, each with where it lives so nobody has
to re-find it.

| # | Fact | Where |
|---|---|---|
| G1 | **Cranes and skybridges are in the legend but never emitted or rendered.** `LEGEND_SPEC` lists `churn … cranes` and `skybridges`, but no coupling pairs reach the manifest or chunks, and the viewer never mentions a crane or a bridge. This already breaks the CLAUDE.md invariant "a legend entry that is turned off must also stop rendering the related geometry" — it's not off, it's just never on. | `analyzer/emit.py:29-43,143`; confirmed by `grep -ri crane viewer/` (no hits) |
| G2 | Per-file git data (`FileGit`) keeps `last_ts`, `commits`, `added`, `deleted`, `authors`, `hashes` — but **no first-commit timestamp** and **no time series**. `git log --date-order` streams newest→oldest, so the *last* time a path is seen while iterating is its birth (earliest commit touching it). | `analyzer/gitmeta.py:35-60,147-214` |
| G3 | `recency_days` is measured from wall-clock `time.time()` via `days_since()`. Any "new" or "age" metric should instead be relative to the repo's own newest commit (`git.last_ts`), so an old clone still shows its newest files as new, and tests stay deterministic regardless of when they run. | `analyzer/gitmeta.py:237`, `analyzer/metrics.py:450` |
| G4 | Districts are **flat at one chosen depth**: `district_key(rel, depth)` truncates every path to that depth. Sub-folders below it are invisible — a district "analyzer/parse" is one block, not a block containing a block. | `analyzer/layout.py:190,434-466` |
| G5 | The viewer only holds **resident** districts in memory (streamed by camera proximity, capped at 20,000 buildings — see `DistrictStreamer`). A filter/count feature that must answer for the *whole* repo (not just what's currently streamed) needs its own small global index; it cannot reuse the resident chunks. | `viewer/js/stream.js:9-60`, `viewer/js/loader.js:142-175` |
| G6 | All text (file/dir names, paths, languages, authors, commit messages) is interned into `strings.bin`, which is **encrypted under `--encrypt`**. Name/path-based filters only work after unlock; numeric/boolean facets (extension bucket aside) can work while locked. | `analyzer/emit.py:46-98,376-405` |
| G7 | Per-instance colour already has a revertible channel: `mesh.userData.baseColors` + `THREE.InstancedMesh.setColorAt`, used today by `setHighlight`/`highlightDistrict`. The per-instance `aTraits` attribute already packs 4 floats (`lit, style, weather, hover`) — **all four slots are used**. A building's geometry already spends 11 of WebGL's 16 guaranteed vertex-attribute slots (per the code comment). New per-instance visual state should reuse colour/emissive before adding a new vertex attribute, and any new attribute needs a slot budget check. | `viewer/js/city.js:245-306,470-590` |
| G8 | Floor-level detail (`f/<id>.json`) already carries `name, kind, doc, line, endLine, loc, depth, srcOffset, srcLength` per floor. Floor-level visual features (S9, S10) need no analyzer change, just viewer consumption. | `analyzer/emit.py:415-487` |
| G9 | `install_viewer()` copies exactly `index.html`, `css/hud.css`, and everything in `js/*.js`. A new page (e.g. `detail.html`) needs to be added to that copy list, and `build_single_file()` needs to either inline it or the single-file build needs an in-page overlay instead (see S19). | `analyzer/emit.py:321-360,728+` |
| G10 | Degeneration flags live in `RepoFlags` (`authorship, recency, churn, coupling`), computed once in `metrics.compute_flags()`, and mapped to legend entries via `enable_map` in `emit.build_manifest()`. Every new legend entry must follow this exact path: a `RepoFlags` field → a rule in `compute_flags` with a human-readable note → an `enable_map` entry → the viewer checking the flag before drawing the geometry. | `analyzer/metrics.py:295-360`, `analyzer/emit.py:139-160` |
| G11 | Test scaffolding: `tests/support.py::make_repo(authors=…, dates=…)` builds a git fixture repo with controllable authors/commit dates; `TempRepoCase.build_city()` runs the full pipeline and returns `(analysis, layout, emit_result)`. The viewer's headless self-test (`?selftest=1`) records assertions via `check(step, ok, detail)` in `viewer/js/main.js::runSelfTest`. | `tests/support.py:68-130`, `viewer/js/main.js:1258+` |

---

## How to read each suggestion

Each numbered item (S1…S19) below should carry, when it's actually built:

1. **Signal** — the repo fact being encoded.
2. **City form** — what appears in the city.
3. **Analogy sentence** — "X looks like Y because Z", filled in.
4. **Data needed** — what fields exist already vs. what's new.
5. **Degeneration rule** — when the repo can't support it honestly, and what the legend says instead.
6. **Files to change**.
7. **Implementation steps**.
8. **Tests / self-test checks**.
9. **Acceptance criteria**.

The fields are filled in below at the level of detail needed to start; a few (S9–S12) are sketched more
lightly since they're later-phase polish.

---

## Group A — Time: new vs. old, hot vs. stable

### S1. Age foundation: first-commit timestamp
*Not a visualization by itself — the data every time-based feature in this group needs.*

- **Signal**: when a file was born, relative to the repo's own history (not wall-clock).
- **Data needed**: new field. `gitmeta.FileGit` gains `first_ts: float = 0.0`; in the per-commit entry
  loop (`analyzer/gitmeta.py:147-214`, the `for path, added, deleted in entries:` block), set
  `record.first_ts = ts if not record.first_ts else min(record.first_ts, ts)` alongside the existing
  `last_ts` update. `metrics.FileMetrics` gains `first_ts`, and `age_days = (git.last_ts - first_ts) /
  86400` computed relative to the repo's newest commit (fixes G3, not `time.time()`). `emit.
  _building_record` adds `"ageDays": round(age_days, 1)`.
- **Files**: `analyzer/gitmeta.py`, `analyzer/metrics.py` (`FileMetrics` dataclass + `analyze()`),
  `analyzer/emit.py::_building_record`.
- **Tests**: extend `tests/test_gitmeta.py` — a fixture via `make_repo(dates=("2024-01-01T…",
  "2024-06-01T…"))` where `alpha/main.py` is touched in both commits should get `first_ts` = Jan and
  `last_ts` = Jun; a file only touched in commit 1 gets `age_days` computed from Jan to Jun (~152 days),
  not from Jan to "now".
- **Acceptance**: golden test in `test_golden.py` asserting `ageDays` is present and computed relative
  to the git index's own `last_ts`, never `time.time()`.

### S2. New construction: scaffolding
- **Signal**: files born within the newest activity window.
- **City form**: a scaffolding/lattice overlay on the facade, distinct from the building's normal
  material.
- **Analogy**: *"New buildings still have scaffolding up."*
- **Data needed**: `is_new = age_days <= window`, where
  `window = max(30, 0.10 * (git.last_ts - git.first_ts) / 86400)` (newest 10% of the repo's lifetime,
  floored at 30 days so a young repo doesn't call everything new). Add `"isNew": bool` to
  `_building_record`.
- **Degeneration rule**: `RepoFlags.age = git.active_dates >= 3 and not all files share one first_ts`.
  When false: `flags.notes.append("All files share one birth date — new-construction disabled.")`,
  and the viewer never applies the scaffolding material. This is the same shape as the existing
  `flags.recency` rule in `compute_flags()` — copy that pattern.
- **Legend entry**: `("new_construction", "First commit within the newest activity window -> scaffolding", "days")`
  added to `LEGEND_SPEC`, mapped in `enable_map` to `flags.age`.
- **Files**: `analyzer/metrics.py` (`RepoFlags`, `compute_flags`), `analyzer/emit.py` (`LEGEND_SPEC`,
  `enable_map`, `_building_record`), `viewer/js/facade.js` (scaffolding overlay), `viewer/js/city.js`
  (drive it from a trait, reusing an existing `aTraits` component or the `style` byte if a bit is free —
  see G7 before adding a 5th attribute float).
- **Tests**: `test_golden.py::test_flags_are_computed_from_the_legend_rules` style test with a
  single-birth-date fixture asserting `flags["age"] is False` and the note text; a second fixture with
  spread birth dates asserting `isNew` is true only for the newest file(s).

### S3. Era: architectural material by age
- **Signal**: how old a file is, independent of when it was last touched (kept distinct from
  weathering, which already exists and encodes *recency of last commit*).
- **City form**: material by age tertile — oldest third: brick/stone tint; middle third: concrete;
  newest third: glass. An old-but-frequently-edited file should read as a "renovated historic
  building": old material (S3) but clean/lit windows (existing weathering + lit-windows logic already
  do this independently).
- **Analogy**: *"You can date a neighbourhood by its architecture."*
- **Data needed**: `age_days` from S1; bucket into tertiles at analysis time
  (`analyzer/metrics.py::analyze`, computed once over `analysis.files` after all records exist) so
  the buckets are relative to *this* repo, not fixed day thresholds.
- **Degeneration rule**: same `flags.age` as S2 — if disabled, uniform material (today's default).
- **Files**: `analyzer/metrics.py` (era bucket, one more field or reuse the `style` trait already
  computed in `viewer/js/city.js::styleFor`), `viewer/js/city.js`/`viewer/js/facade.js` (era → base
  colour or `roughness`/`metalness` shift). Prefer driving this from an existing attribute slot; per
  G7, don't add a new per-vertex attribute for this if `style` already has spare bits.
- **Tests**: unit test that three files with three well-separated `first_ts` values land in three
  different era buckets.

### S4. Activity heat: hot vs. stable
- **Signal**: is this file under active development right now, weighted toward recent commits (not
  just total churn, which the existing crane system already tracks as a lifetime top-decile).
- **City form**: a rooftop beacon (small emissive point/sprite, or an emissive-intensity pulse on the
  crown) whose brightness is the file's recent-activity percentile. **This also finishes the existing
  legend promise for cranes (G1)**: cranes become "top decile of recent-activity heat" instead of a
  dangling legend entry.
- **Analogy**: *"Busy buildings have their lights on and a crane on the roof; quiet ones sit dark."*
- **Data needed**:
  - `FileGit.activity: list[int]` — 24 monthly buckets of commit count, indexed by months-before
    `git.last_ts` (bucket 0 = the month containing `last_ts`). Filled in the same per-commit loop as
    `first_ts`/`last_ts` (`analyzer/gitmeta.py:147-214`): compute
    `bucket = int((git.last_ts - ts) // (30 * 86400))`, clamp to `[0, 23]`, increment.
    Note: `git.last_ts` isn't known on the first pass through commits (git log is newest-first, so
    actually it *is* known immediately — the first commit read has the max timestamp — but to keep
    this simple, do the bucketing in a second pass over `index.files` after the main loop, once
    `index.last_ts` is final).
  - `recent_churn = Σ (added+deleted for each commit) × 0.5^(days_before_last_commit / 30)` — an
    exponential half-life decay, computed per file from its commit list. Requires per-commit
    added/deleted attributed to timestamp, not just the running total `FileGit.added/deleted` — extend
    `FileGit` with a `commit_log: list[tuple[float, int]]` (timestamp, churn-for-that-commit) if not
    already reconstructable from `hashes` (it currently isn't — `hashes` has no size info). Cap
    `commit_log` length or skip storing it and instead compute `recent_churn` incrementally in the same
    loop (`recent_churn += (added+deleted) * 0.5 ** ((last_ts_seen_so_far - ts)/30/86400)` — needs care
    since `last_ts` isn't final until the loop ends; simplest correct approach: store `commit_log` and
    do the decay math in a second pass, same as `activity`).
  - `heat = percentile_rank(recent_churn)` across `analysis.files`, computed once in `metrics.analyze()`.
  - Emit `"activity": [..24]` and `"heat": 0..1` in `_building_record`.
- **Degeneration rule**: reuses existing `flags.churn` (`git.commit_count >= 5 and
  git.max_eligible_commit_files >= 2`). When false: no beacons, no cranes — this is already the
  existing crane behavior in spirit, just now it's real.
- **Files**: `analyzer/gitmeta.py` (`FileGit.commit_log`, second-pass bucketing), `analyzer/metrics.py`
  (`heat` percentile, `FileMetrics` fields), `analyzer/emit.py` (`_building_record`), `viewer/js/city.js`
  (beacon geometry — small additional instanced mesh per archetype tier, gated by `flags.churn`,
  positioned above `ROOF_DECK` height like the existing roof-candidate logic).
- **Tests**: `tests/test_gitmeta.py` — commits spread across distinct months, assert `activity` buckets
  land correctly and a file with commits concentrated near `last_ts` has higher `heat` than one with the
  same total churn spread evenly across history.
- **Acceptance**: `python3 bench/generate_repo.py` scale test — beacon draw calls stay per-archetype
  (instanced), not per-building.

### S5. Sector activity: district ground heat
- **Signal**: which folder is under the most active development right now.
- **City form**: district pavement tinted on a sequential palette by the district's share of total
  recent-activity heat (Σ `heat` of its buildings ÷ Σ over the city). Streets between districts whose
  files frequently co-change (S6 pairs, summed at the district level) get a thicker "traffic" ribbon.
- **Analogy**: *"You can see which neighbourhoods are being redeveloped."*
- **Data needed**: per-district aggregate, computed in `analyzer/emit.py::build_manifest` alongside the
  existing district loop (`districts.append({...})`, around line 163-198) — add `"heat"` (mean or
  weight-summed) and `"newFiles"` (count where `isNew`) to each district's manifest entry.
- **Degeneration rule**: same `flags.churn`; when false, uniform pavement (today's ground texture).
- **Files**: `analyzer/emit.py::build_manifest`, `viewer/js/city.js` (ground/street tinting — the
  ground texture is currently built once in `makeGroundTexture`; district-level tint needs either a
  per-district ground quad or a vertex-colour pass on the shared ground plane).
- **Tests**: `test_emit.py` asserting district `heat` reflects its member files' heat and sums
  reasonably; golden fixture with two districts, one with recent commits and one with only old ones.

### S6. Skybridges — finish the existing legend promise
- **Signal**: files that change together in the same commit (the coupling data `gitmeta.GitIndex`
  already computes and the legend already advertises — this item is closing G1, not inventing a new
  concept).
- **City form**: an arc/tube between the two buildings' rooftops.
- **Analogy**: *"Files that always change together are joined by a bridge."* (Already in README.md's
  legend table — this makes it real.)
- **Data needed**: `GitIndex.coupling: dict[(path,path), count]` already exists
  (`analyzer/gitmeta.py:159-166`). Emit the top-K pairs (K ≤ 2,000, strongest count first) as a new
  file `bridges.json`: `[[buildingIdA, buildingIdB, count], ...]`, using the same `building_index`
  mapping `emit_city()` already builds (`analyzer/emit.py:611-620`). Only emit pairs where both ends
  survived filtering (both paths are still buildings, not excluded/noise).
- **Degeneration rule**: gated by the existing `flags.coupling`
  (`git.eligible_commits >= 2 and len(git.coupling) > 0`). When false: no `bridges.json`, or an empty
  one, and the viewer draws nothing — this already matches the existing note text
  ("Co-change coupling disabled...").
- **Files**: `analyzer/emit.py::emit_city` (write `bridges.json` next to `city.json`), `viewer/js/loader.js`
  (fetch it, likely lazily / only when both endpoints are resident — mirrors how `stream.js` already
  decides residency), `viewer/js/city.js` (new instanced tube/line geometry, gated by `manifest.flags.coupling`).
- **Tests**: `test_gitmeta.py` already has coupling fixtures (`test_small_commits_produce_coupling`,
  `test_single_commit_that_touches_everything_is_bulk`) — extend `test_emit.py` to assert `bridges.json`
  is written when `flags.coupling` is true and matches `GitIndex.coupling`, and is absent/empty
  (with a reason in `flags.notes`) when false.
- **Acceptance**: self-test check `bridges-only-when-coupling` in `runSelfTest`.

### S7. Time-lapse: watch the city being built
- **Signal**: the repo's construction history.
- **City form**: a scrub slider (alongside the existing time-of-day slider in the HUD footer,
  `#time`/`#time-out`) over the 24 monthly buckets from S4. Building height stays fixed (never
  animated — the CLAUDE.md invariant that height = logical lines must not be touched); instead,
  buildings **appear** at their `first_ts` month by animating scale-Y from 0 to 1, and beacons (S4)
  pulse according to that month's `activity[bucket]`.
- **Analogy**: *"Watch the city being built."*
- **Data needed**: none beyond S1 + S4 — this is pure viewer work once those land.
- **Degeneration rule**: hide the slider entirely when `flags.age` is false (S2's flag) since without
  spread birth dates there's nothing to scrub.
- **Files**: `viewer/index.html` (new slider control), `viewer/js/main.js` (wire it up next to
  `applyTime()`), `viewer/js/city.js` (per-instance scale-Y animation driven by a new time-lapse cursor
  state, likely reusing the existing matrix-per-instance update path used at build time).
- **Tests**: self-test check that scrubbing to month 0 shows only files with `ageDays` within the
  newest bucket window at full scale, and older files at scale 1 (already built), never scale 0
  (never un-build a file once it exists).

---

## Group B — Downtown

### S8. Downtown: the city's centre of gravity
- **Signal**: which files are the most structurally central to the repo — not just biggest or oldest,
  but most connected (co-change degree, import fan-in, current activity, ownership breadth).
- **City form**: the top ~5% (min 3) of files by a composite centrality score get a glass material and
  an antenna/spire crown, regardless of their archetype. A district whose downtown-file density is
  ≥ 2× the city mean is a **CBD**: darker asphalt tint, a floating label, and a line in City Hall's
  report card.
- **Analogy**: *"Downtown is where the roads meet and everyone works."*
- **Data needed**:
  - Composite score, computed once over `analysis.files` after all other metrics are known:
    `0.35·rank(coupling_degree) + 0.35·rank(import_in_degree) + 0.20·rank(heat) + 0.10·rank(author_count)`,
    using percentile ranks so the components are comparable regardless of scale. When a component's
    flag is disabled (e.g. `flags.authorship` false in a single-author repo, or `flags.coupling` false),
    drop that term and renormalize the remaining weights; note which components were dropped in
    `flags.notes`.
  - `coupling_degree`: count of `GitIndex.coupling` pairs a file appears in (already computable from
    existing data, no new git parsing needed).
  - `import_in_degree`: **new** — requires an import graph. `analyzer/parse/python_ast.py` gains
    collection of `ast.Import`/`ast.ImportFrom` nodes, resolving module names to repo-relative paths
    (try relative import resolution first, then match against known top-level package names collected
    during the walk). Add `ParseResult.imports: list[str]` (repo-relative paths, best-effort). For
    brace-heuristic languages (`analyzer/parse/brace.py`), add a regex pass for
    `import ... from '...'` / `require('...')` in JS/TS — mark `confidence: "medium"`, consistent with
    the existing brace-heuristic confidence convention. Build the in-degree count once all files are
    parsed, in `analyzer/metrics.py::analyze()` (a second pass, since in-degree needs every file's
    outgoing imports first).
- **Degeneration rule**: new `RepoFlags.centrality` = true only if at least two of the four components
  are available and non-degenerate (e.g. coupling has real data, or at least one file has an import).
  Note explains exactly which components fed the score.
- **Files**: `analyzer/parse/python_ast.py`, `analyzer/parse/brace.py`, `analyzer/parse/__init__.py`
  (`ParseResult.imports` field), `analyzer/metrics.py` (score computation, `RepoFlags.centrality`),
  `analyzer/emit.py` (`_building_record` adds `"downtown": bool`, `"centrality": float`; district-level
  CBD flag in `build_manifest`), `viewer/js/city.js` (glass material + antenna crown archetype override),
  `viewer/js/inspector.js` (show centrality score breakdown), `viewer/js/main.js`
  (City Hall CBD listing — see existing `renderTitle`/City Hall body rendering).
- **Optional layout step**: in `analyzer/layout.py::build_layout`, once CBD districts are known, order
  `entries` (the sorted district-weight list, `analyzer/layout.py:451`) so CBD districts are placed in
  the band nearest the plaza first (`_spread_over_bands`, line 378) — physically central "downtown".
  This is a smaller, separable follow-up; land the metric first.
- **Tests**: fixture repo where one file is imported by every other file (a `utils.py`) — assert it
  scores highest centrality and gets `downtown: true`; assert a repo with no imports and no coupling
  data disables `flags.centrality` with an explanatory note.

---

## Group C — Depth of buildings

*(Lighter-weight, later-phase polish — sketched at the level needed to schedule, not to start
immediately.)*

### S9. Floors that mean something
- **Signal**: what kind of symbol each floor represents (already known: `floor.kind` — function,
  class, heading, cell — see G8).
- **City form**: tint floor bands by `kind`; floor thickness scales with `floor.loc`; a lit "penthouse"
  for entrypoints (`if __name__ == "__main__"`, a `main()` function, `index.*` files).
- **Analogy**: *"Offices vs. apartments; the penthouse is the front door."*
- **Data needed**: all present in `f/<id>.json` (G8); entrypoint detection is a small new heuristic in
  `analyzer/parse/python_ast.py` / `analyzer/metrics.py` (flag a floor as `is_entrypoint`).
- **Files**: `analyzer/parse/python_ast.py` (entrypoint flag), `viewer/js/facade.js`/`viewer/js/interior.js`
  (floor band tinting by kind, already has access to floor kind when building interiors).

### S10. Complexity: structural bracing
- **Signal**: cyclomatic complexity per file (Python: exact from AST — count
  `If/For/While/Try/BoolOp/comprehension` nodes; brace languages: keyword-count heuristic, medium
  confidence, consistent with the existing brace-heuristic convention).
- **City form**: diagonal cross-bracing on the facade, density scaling with complexity-per-line.
- **Analogy**: *"Complex buildings need extra structural support."*
- **Files**: `analyzer/parse/python_ast.py`, `analyzer/parse/brace.py` (complexity field on
  `ParseResult`), `viewer/js/facade.js` (bracing geometry/texture).

### S11. Dependencies: underground utilities
- **Signal**: the import graph from S8, shown as a distinct relationship from co-change (S6).
- **City form**: an "Underground" HUD toggle that reveals import edges as tunnels below street level.
- **Analogy**: *"The pipes you never see connect buildings you'd never guess."*
- **Files**: reuses S8's `ParseResult.imports`; new toggle in `viewer/index.html`/`viewer/js/main.js`;
  tunnel geometry in `viewer/js/city.js`, kept visually and conceptually separate from S6's skybridges.

### S12. Bus-factor-1: single tenant
- **Signal**: `ownership_share ≥ 0.9` and `commits ≥ 3` in a multi-author repo — one person could walk
  away and this file would be an orphan.
- **City form**: a single lit floor plus a small "sole tenant" marker.
- **Analogy**: *"If the one tenant leaves, the building is empty."*
- **Data needed**: all present already (`ownership_share`, `commits`, `flags.authorship`) — pure viewer
  + one boolean field.
- **Files**: `analyzer/emit.py::_building_record` (`"soleTenant": bool`), `viewer/js/city.js`/`inspector.js`.

---

## Group D — Folders and sub-folders

### S13. Nested plots: borough → neighbourhood → block
- **Signal**: folder nesting below the currently-chosen single district depth (G4).
- **City form**: a recursive treemap. Each nesting level sits on a plinth ~0.15m higher than its
  parent, inset further, with progressively thinner streets (avenue → street → alley). Labels appear
  by camera distance: top level visible from far away, deeper levels only up close.
- **Analogy**: *"Boroughs contain neighbourhoods contain blocks."*
- **Data needed**: replace the flat grouping in `analyzer/layout.py::build_layout`
  (`grouped: dict[str, list[FileMetrics]]` keyed by `district_key(record.rel, chosen)`) with a
  recursive structure: group by full path prefix at every depth up to `chosen`, not just at `chosen`.
  The **leaf level stays exactly as it is today** (same `district.key`, same chunk file, same building
  placement) so streaming (`viewer/js/stream.js`) and the manifest's per-district chunk contract are
  unaffected. Add a new manifest array `"regions": [{id, key, name, rect, depth, parent}]` describing
  every intermediate level (the ground plinths), separate from `"districts"` (unchanged, leaf-only).
- **Risk / must verify**: the City Hall plaza reserve (`_reserve`, `_frame_around`,
  `_streets_around` in `analyzer/layout.py`) and `_spread_over_bands` currently operate once, at the
  top of `build_layout`, on the full flat district list. They must continue to operate once, at the
  outermost region level only; the recursive subdivision happens *inside* each top-level band's
  rect, using the existing `_treemap` function recursively instead of the current single flat call
  (`analyzer/layout.py:462`). `tests/test_layout.py`'s scale assertions (plan sizes 60m–3.2km) must
  keep passing unmodified — this is the highest-risk item in the whole roadmap, which is why it's
  scheduled after the data-only features (see Build order).
- **Files**: `analyzer/layout.py` (`build_layout`, `_treemap`, new region tracking), `analyzer/emit.py`
  (new `"regions"` array in `build_manifest`), `viewer/js/city.js` (plinth geometry per region level),
  `viewer/js/main.js` (distance-based region label rendering).
- **Tests**: `tests/test_layout.py` — new cases with 3+ levels of nesting asserting leaf districts are
  byte-identical to today's flat output (same `key`, `rect`, `buildings`) and that `regions` correctly
  nests (each leaf district's `district` id traces back through `regions` to the repo root).

### S14. Drill-down and breadcrumb
- **Signal**: navigation through the S13 region hierarchy.
- **City form**: clicking a region zooms the camera to it and fades everything outside it (colour-lerp
  toward the ground colour via the existing `baseColors` mechanism, G7 — same technique as
  `highlightDistrict`, inverted). A HUD breadcrumb (`repo / src / analyzer`) lets you click back up.
- **Analogy**: implicit in S13; this is the interaction, not a new encoding.
- **Files**: `viewer/js/city.js` (extend `highlightDistrict`/`clearDistrictHighlight` pattern to
  regions and to an inverse "fade everything else" mode), `viewer/js/main.js` (breadcrumb HUD element,
  camera zoom-to-region using the existing `teleportTo`).

---

## Group E — Slice and filter ("zoning map")

### S15. Global facet index — data foundation for S16–S18 (fixes G5)
*Not a visualization by itself.*

- **Problem it solves**: filtering/counting ("how many `.py` files? how many `CLAUDE.md`?") must work
  across the **whole repo**, but the viewer only keeps resident (camera-proximate) district chunks
  loaded (G5). A global index avoids fetching every district chunk just to answer a count.
- **Data needed**: new emitted file `index.json`, one compact row per building, **arrays, not
  objects**, to keep it small at scale:
  `[id, districtId, archetypeCode, languageIdx, extIdx, nameIdx, flagsBitmask, loc, ageDays, heat]`
  where:
  - `archetypeCode`: small int, mapped via a fixed enum (matches `ARCHETYPE_COLORS` keys in
    `viewer/js/city.js`).
  - `languageIdx`/`nameIdx`: indices into the existing `strings.bin` table (so they respect
    encryption — see G6).
  - `extIdx`: index into a **new, always-unencrypted** small extension string table (`.py`, `.md`,
    etc.) — deliberately separate from `strings.bin` so extension-based filtering (`ext:py`) works
    even in a locked city; filenames/paths (`name:CLAUDE.md`) remain locked until unlock, which is the
    correct behavior per G6 (a locked city must not leak filenames).
  - `flagsBitmask`: `isTest | isDoc | isBinary | isRuin | isNew | isDowntown | isData`, one bit each.
  - `heat`/`ageDays`: from S4/S1, or 0/omitted if those phases aren't built yet — this item should be
    buildable independently of S1–S8, just with fewer columns initially.
- **Size budget**: ~40 bytes/row × 50,000 files ≈ 2 MB — check against `bench/generate_repo.py`'s
  50k-file synthetic repo and the existing load-time budget in `viewer/js/main.js::runBench`.
- **Files**: `analyzer/emit.py` (new `_index_row()` helper + write `index.json` in `emit_city()`,
  alongside the existing per-district chunk loop), `viewer/js/loader.js` (fetch `index.json` once, up
  front, independent of streaming), a new small module (e.g. `viewer/js/facets.js`) providing
  `query(rows, predicateString)`.
- **Tests**: `test_emit.py` — assert `index.json` row count equals `stats.fileCount`, bitmask flags
  match the corresponding per-building booleans in the district chunks, and extension index survives
  `--encrypt` (unencrypted) while name index does not (locked until unlock).

### S16. Filter bar with a mini query language
- **Signal**: user-driven ad-hoc slicing.
- **City form**: a HUD text input parsing simple ANDed terms (`-` negates):
  `ext:py`, `name:README.md`, `name:CLAUDE.md`, `lang:javascript`, `path:analyzer/**`,
  `is:test|doc|data|binary|new|downtown`, `loc>500`, `age<30d`, `heat>0.9`, `author:alice`.
  Matches keep full colour/lit state; non-matches go translucent ghost-grey. A result counter reads
  `42 files · 3,210 lines · in 6 districts`, plus a per-district match-count breakdown. Distant/impostor
  districts show their match count as an overlay.
- **Analogy**: *"A zoning map: every building of one use lights up."*
- **Data needed**: S15's `index.json`.
- **Files**: `viewer/index.html` (filter input + result counter in the HUD), `viewer/js/facets.js`
  (query parsing — a small hand-written parser is enough, no need for a real grammar library),
  `viewer/js/city.js` (new `CityMesh.applyFilter(matchingIdSet)` / `clearFilter()`, modelled directly
  on the existing `highlightDistrict()`/`clearDistrictHighlight()` pair at lines 530-590 — same
  base-colour-lerp technique, opposite direction for non-matches), `viewer/js/main.js`
  (wire the input, re-apply the active filter inside `rebuildCity()` after every streaming update since
  resident buildings change as the camera moves).
- **Tests**: self-test checks `filter-count-matches-index` (typing `name:README.md` produces a count
  equal to counting `isDoc` rows named exactly `README.md` in `index.json`) and
  `filter-ghosts-nonmatches` (non-matching resident buildings have reduced `instanceColor`/opacity).

### S17. Colour-by lens
- **Signal**: re-purposing the whole city's colour channel as a single legend, on demand.
- **City form**: a dropdown — archetype (today's default) | language | age (S3) | heat (S4) | author |
  doc coverage | downtown (S8). Selecting one re-tints every building via `baseColors` and swaps the
  legend panel (`renderLegend()`/`renderXray()` in `viewer/js/main.js`) to that lens's key. Lenses whose
  backing flag is off are shown in the dropdown but disabled, with the flag's note as a tooltip.
- **Files**: `viewer/index.html` (dropdown), `viewer/js/main.js` (`renderLegend`, lens state),
  `viewer/js/city.js` (a `recolour(lens)` method that recomputes every instance's `baseColors` from the
  chosen lens instead of always using `tintFor(archetype, author)` as `build()` does today).

### S18. Facet chips
- **Signal**: quick counts without typing a query.
- **City form**: chips for top languages, archetypes, and named special files (`README*`, `CLAUDE.md`,
  `LICENSE`, `Dockerfile`, `.github/workflows/*`, package manifests like `package.json`/`pyproject.toml`),
  each showing a count from `index.json`. Clicking a chip fills S16's query input.
- **Files**: `viewer/js/facets.js` (facet aggregation over `index.json`), `viewer/index.html`/`main.js`
  (chip rendering).

---

## Group F — Detail windows

### S19. Detail window for a building, a district, or a selection
- **Signal**: "I want everything about this one thing, in depth, without leaving the city metaphor."
- **City form**:
  - **Building view**: an isolated orbiting 3D render of just that one building (reuse
    `nearGeometry()`/`MASSING_CACHE` from `viewer/js/city.js`, `patchFacade()` from `viewer/js/facade.js`,
    the massing functions in `viewer/js/shapes.js`); a floor table (name, kind, loc, doc — from the
    existing `f/<id>.json`) where each row is clickable to show its exact source slice (already
    computed via `srcOffset`/`srcLength`, G8, using `CitySource.source()` in `viewer/js/loader.js`); the
    S4 24-month activity sparkline; an authors bar chart; the S6 co-changed-files list (from
    `bridges.json`); the S8 centrality/downtown score with its component breakdown.
  - **District view**: a mini 3D render of just that district's chunk (reuse `CityMesh.build()` scoped
    to one district's buildings); language breakdown, top-by-lines, hottest (S4), newest (S1) files,
    README status, the S13 sub-folder tree, activity over time.
  - **Selection view**: the same aggregate report, but for an arbitrary S16 filter query result, or a
    lasso-selected rectangle in overview mode (`O`) — drag a rectangle, emit a synthetic
    `rect:x,y,w,h` query.
- **Analogy**: this is the "go inside and look closely" gesture the city already has for a single
  building's *interior* (`viewer/js/interior.js`) — S19 extends the same idea to a standalone, shareable
  window and to a district/selection scope the interior mechanism doesn't cover.
- **Entry point**: `viewer/js/inspector.js`'s `showBuilding()`/`showDistrict()` gain an
  "Open details ↗" button that opens `detail.html?b=<id>` or `detail.html?d=<districtId>` (or
  `?q=<query>` for a selection) in a new tab/window.
- **Coordination back to the main window**: a `BroadcastChannel('zion')`. Clicking a co-changed file or
  a sub-folder row in the detail window posts `{fly: buildingId}`; the main window's existing
  `teleportTo()` (`viewer/js/main.js:837`) handles it.
- **Locked cities**: the detail page runs the same `viewer/js/vault.js` unlock flow and shows
  procedural addresses until unlocked, exactly like the main window.
- **`--single-file` builds (G9)**: there's no second HTML document to link to in a single-file build.
  Detail opens as a full-screen `<section id="detail" hidden>` overlay inside `index.html` instead,
  using the same `detail.js` module — the single-file path skips `detail.html` entirely and inlines
  the overlay markup/module like everything else `build_single_file()` inlines.
- **Files**: new `viewer/detail.html` + `viewer/js/detail.js`; `analyzer/emit.py::install_viewer`
  (copy `detail.html`) and `::build_single_file` (inline as overlay instead, per above);
  `viewer/js/inspector.js` (open-details button); `viewer/index.html` + `viewer/js/main.js` (single-file
  overlay markup/wiring); `viewer/index.html` (lasso rectangle drag in overview mode, likely in
  `viewer/js/cameras.js` or `main.js` near the existing overview toggle).
- **Tests**: self-test checks `detail-open-building` and `detail-open-district` (page loads, renders
  the requested id's data, doesn't throw); `test_emit.py` asserting `detail.html` is present in
  `install_viewer()`'s output and that a single-file build contains the overlay markup instead.

---

## Build order, and why each phase is where it is

| Phase | Items | Why here |
|---|---|---|
| **0 — Honesty fixes** | S6 (skybridges), cranes wired to real churn data (usable immediately from existing `commits`/`churn` fields even before S4 lands, as an interim top-decile-of-lifetime-churn rule) | The legend already promises these (G1). Fixing a broken promise takes priority over adding new ones, and it's small — `GitIndex.coupling` and per-file churn already exist; this is emission + rendering, no new metric design. |
| **1 — Filter & inspect** | S15 (index) → S16 (filter bar) → S18 (chips) → S19 (detail window, building + district) | Highest value per unit of effort, and answers the user's explicit question ("how many `CLAUDE.md` / `.py` files?") directly. Almost entirely viewer-side; S15 is the only analyzer change and it's additive (one new small file, no changes to existing chunks/geometry). S19 is the "open a window with full detail" the user asked for by name. |
| **2 — Time signals** | S1 (age foundation) → S4 (activity heat, finishes cranes properly) → S2 (scaffolding) → S5 (district heat) → S3 (era material) → S17 (colour-by lens) | S1 and S4 are the two `gitmeta` additions everything else in this phase (and S8, S13's "recent" framing) depends on — do them first and once. The lens (S17) is listed last in this phase because it wants age/heat/downtown to already exist to be worth building; it can also ship earlier with just archetype/language/author if desired. |
| **3 — Structure** | S8 (downtown — needs S4's heat and S6's coupling degree, plus new import parsing) → S13 (nested districts) → S14 (drill-down) | Downtown genuinely depends on Phase 2's heat data and Phase 0's coupling degree, so it can't move earlier. S13 is flagged as the highest-risk item in this whole roadmap (touches `layout.py`'s treemap/plaza-reservation math, which has scale tests from 60m to 3.2km) — it's scheduled after every purely-additive data feature is stable and tested, so if something regresses it's easy to isolate. |
| **4 — Depth & motion** | S9 (meaningful floors), S12 (single tenant), S10 (bracing), S11 (underground utilities), S7 (time-lapse), S19's lasso/selection extension | Pure polish riding on data that phases 0–3 already produced. Lowest urgency, safe to defer or reorder freely among themselves. |

**Process rule for whoever builds this**: one PR per item (S1, S2, … not "Phase 1" as one PR), each
with its own tests, and each PR updates the README's legend table and CLAUDE.md's test count in the
same PR — both already document the current legend/test count and must stay in sync per the existing
convention (`README.md`'s "The legend" section, `CLAUDE.md`'s "74 tests" line).

---

## Invariants every item above must respect

Copied from `CLAUDE.md` and made concrete for this roadmap:

- **Height stays logical lines/rows, always.** S7's time-lapse animates *appearance* (scale from 0 at
  birth), never final height. No item in this roadmap changes what drives height.
- **Plain vs. encrypted geometry must stay byte-identical.** Every new numeric field (`ageDays`, `heat`,
  `isNew`, `downtown`, `activity[]`, `bridges.json` ids) lives in chunk/manifest JSON alongside existing
  geometry fields and must be computed identically regardless of `--encrypt`. Only text — anything
  routed through `strings.bin` (S15's `nameIdx`, `languageIdx`) — differs under encryption; S15's `extIdx`
  is deliberately kept in its own always-plaintext table specifically so numeric/extension filtering
  doesn't require unlock, matching how the rest of the geometry already behaves.
- **Every new legend entry needs the full chain**: a `RepoFlags` field → a `compute_flags()` rule with
  a human-readable note → an `enable_map` entry in `build_manifest()` → the viewer checking that flag
  before drawing the related geometry. A test using `tests/support.py::make_repo(authors=(...,),
  dates=(...,))` with a degenerate fixture (one author, one date, few commits) must assert the flag is
  false, the note is present, and the viewer-visible effect (self-test check) is that the geometry does
  not appear.
- **A legend entry with a layer of its own also gets a City Guide switch.** The `LEGEND_KEYS` table in
  `viewer/js/main.js` is the viewer's half of the same contract: it names the layer each entry draws
  (`archetype`, `mesh` or `option`) so the reader can switch it off by hand. An entry with no separate
  layer is listed as inert, never given a dead control. Adding a legend entry without a `LEGEND_KEYS`
  row leaves the City Guide incomplete; the `keys-covers-legend` self-test check fails if the two lists
  drift apart.
- **`analyzer/` never writes into the analyzed repo.** All new emitted files (`index.json`,
  `bridges.json`, `detail.html`) go into `-o DIR` / the cache dir, same as everything else.
- **No generated demo city gets committed.** Building any of these locally for testing must not add
  `out/` or city artifacts to the repo.
- **Draw calls must not scale with building count.** Beacons (S4), cranes, bridges (S6), scaffolding
  (S2), and bracing (S10) all need to be instanced meshes (one per archetype/tier, like everything else
  in `viewer/js/city.js`), not one mesh per building.

---

## Verification checklist per phase

- **Automated**: `python3 -m unittest discover -s tests -p 'test_*.py'` must stay green throughout.
  Add cases to `tests/test_gitmeta.py` (S1, S4), `tests/test_golden.py` (new manifest/chunk fields,
  flag rules), `tests/test_emit.py` (`index.json`, `bridges.json`, `detail.html` installed, plain vs.
  encrypted field identity), `tests/test_layout.py` (S13's nested regions vs. today's flat output).
- **Headless self-test**: add checks to `viewer/js/main.js::runSelfTest` as each viewer feature lands —
  `filter-count-matches-index`, `filter-ghosts-nonmatches`, `lens-recolours`, `detail-open-building`,
  `detail-open-district`, `bridges-only-when-coupling`, `cranes-only-when-churn`. Run via:
  ```
  "/path/to/Chrome" --headless=new --no-sandbox --enable-unsafe-swiftshader \
    --virtual-time-budget=60000 --dump-dom "http://127.0.0.1:PORT/?selftest=1"
  ```
- **Scale**: `python3 bench/generate_repo.py bench/tmp/repo-50000 --files 50000 --commits 40`, then
  `python3 zion.py build bench/tmp/repo-50000`. Compare `runBench()`'s frame time and load time against
  the pre-change baseline — new features (beacons, filter ghosting, bridges) must stay within ~10% of
  it, since none of them should add per-building draw calls (see invariants above).
- **Manual smoke test**: `python3 zion.py serve /path/to/repo`; type `name:CLAUDE.md` in the filter bar
  and confirm the count; open a building's detail window and confirm it renders that one building
  correctly; toggle the colour-by lens and confirm the legend panel updates to match.
