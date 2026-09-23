# Zion

![Zion-city-shot](<sample-zion.png>)
**Turn any repository into an explorable 3D city.**

Folders are districts. Files are buildings. A file's insides are its floors. You
answer *"which folders have no README?"*, *"which files are huge and
undocumented?"* and *"who owns this part of the codebase?"* by reading a skyline
instead of a report.

To someone who doesn't know what it encodes, it is just a city. That is the
point.

```
python3 zion.py stats  /path/to/repo        # text report, no 3D at all
python3 zion.py build  /path/to/repo        # write a city into ./out
python3 zion.py serve  /path/to/repo        # build if needed, serve, open a browser
python3 zion.py report /path/to/repo        # the architect's report as Markdown (or --format json)
python3 zion.py build  /path/to/repo --compare v1.2   # mark everything that changed since a release
python3 zion.py report /path/to/repo --compare main --fail-on new-cycle,new-violation   # a CI gate
```

Pure standard library. No `npm`, no `node_modules`, no third-party packages, no
install step. `three.js` is vendored as a single file so the viewer works with
no network at all.

---

## The legend

Everything in the city is one of these, and nothing is decoration.

| Repo signal | City form |
|---|---|
| **logical source lines** (never bytes on disk) | building height |
| **logical lines per floor** (bytes on disk only when there is no floor plan) | footprint area |
| how evenly the file divides into floors | footprint shape: even → square, lopsided → slab |
| top-level functions / classes / headings / notebook cells | floors |
| folder content weight | district area (treemap) |
| folder nesting | raised plinths, one step per level; folder names on the map, deeper names as you fly closer |
| how far apart two folders are in the tree | road class: highway (top-level folders, the ring road) → avenue → street → alley |
| dominant author by lines owned | building tint, district Mayor |
| recent activity (heat), top decile | a crane |
| days since last commit | weathering: clean → grimy → derelict |
| docstring + comment ratio | **fraction of lit windows** |
| README in the folder | Town Hall landmark |
| test files | parks |
| data files | silos (height = row count) |
| binary artefacts | monuments |
| files changed together in one commit | listed under "Changes together with" in the detail report |
| first commit within the newest activity window | scaffolding |
| recent, decay-weighted churn (percentile) | graded rooftop beacon (top decile: a crane instead); district ground heat |
| co-change degree + import in-degree + heat + author count | downtown towers (glass tint, antenna) |
| one author owns ≥ 90% of a file's lines | a corner flag (bus factor 1) |
| decision points per function/class (exact for Python, heuristic elsewhere) | floor complexity, shown in the detail report |
| a `__main__` guard or a function named `main`/`run` | a ⭐ next to that floor in the detail report |
| **hotspot**: commit frequency × size, top 5% | striped hazard barriers around the plot |
| **oversized**: top 5% by logical lines and ≥ 400 of them | raking shores (buttresses) braced against the walls |
| **orphan candidate**: nothing imports it, not an entry point, untouched 6 months | boarded up: dark windows, a vacancy sign |
| **import cycle** (strongly connected imports) | a rooftop pennant, one colour per cycle |
| **knowledge risk**: main author inactive 6+ months | the corner flag turns red |
| **layering violation**: an import against `.zion/rules.json`, or against the majority direction between two folders | a red no-entry sign at the plot corner |
| **untested risk**: a hotspot, oversized or downtown file no test is linked to | traffic cones at the kerb |
| **branch-heavy**: one function with 15+ decision points | steel cross-bracing up the facade |
| **CODEOWNERS drift**: the declared owners commit, but not to this file | a purple notice board |
| **changed since the baseline** (last build, or `--compare REV`) | a survey stake: green added, blue grown, grey shrunk |
| the selected building's imports and importers | utility lines: blue out, amber in, red against the layering |
| the selected building's co-change partners | teal rings on the ground |
| the selected folder's imports and co-change with other folders | arcs between districts, as thick as the relationship |
| first commit dates | the History slider rebuilds the city as it stood on any day |

The architect's signals (the last rows) are computed in `analyzer/health.py`,
`analyzer/architecture.py`, `analyzer/testmap.py`, `analyzer/owners.py` and
`analyzer/history.py` from numbers the analysis already has. Each is relative to the repository itself
and gated on its own degeneration flag. Vendored third-party code (`vendor/`,
`third_party/`, `*.min.js`) is left out of all of them.

The **City Guide** (left panel, `L` to hide) is the legend made switchable,
explained and counted. It has three tabs.

- **Read the city.** Every legend entry is a row, grouped as *Size & shape*,
  *Ground*, *Construction & time*, *People*, *Civic*, *Health* and *Forms*. A row
  shows the entry's real on-screen colour, its one-line encoding, and a live
  count of the buildings in the whole repository that carry it.
- **Health.** The architect's shortlist, described below.
- **Filter.** The zoning filter and the colour lens.

Clicking a row's name expands it into the full rule and the analogy behind it.
Where a count exists, a **Highlight** button filters the city to exactly those
buildings.

Each row with a layer of its own has a switch that hides that layer, so the city
can be read one signal at a time. How a switch works depends on the layer:

- **A form** is dropped when the city is built. It takes its rooftop clutter and
  its collision box with it, so it cannot be hovered or walked into.
- **A prop cluster** is its own instanced mesh and is simply hidden: cranes,
  beacons, scaffolding, flags, barriers, shores and pennants.
- **An encoding baked into the buildings** rebuilds the city with that option
  off: author tint, weathering, lit windows, downtown glass and boarded windows.

Entries that are pure encodings (height, footprint, floors, district area, roads,
plinths) show an *always* badge instead of a dead switch. An entry the
degeneration rules turned off says *off* and why. *Show every layer* restores
everything.

The **Health** tab lists the top hotspots, oversized files, import cycles,
knowledge risks, possible dead code, layering violations, untested risk,
branch-heavy code and CODEOWNERS drift, plus what changed since the baseline, the
heaviest dependencies between folders and your own notes. Clicking one flies to it. The
**health** colour lens tints every building by its most pressing signal.

**Click a building** and the inspector explains it rather than listing numbers:

- **What you're looking at.** Its form and why, plus a badge for every prop on
  it and the rule that put it there.
- **Reading the structure.** Height in logical lines and metres; what its floors
  are ("30 floors = 3 classes, 23 functions at the top level + 4 nested
  definitions (StringTable, EmitOptions, …)"); its footprint and area and what a
  wide plan means; lit windows as documentation; and how weathered it is.
- **People.** Who built it (first commit), who last edited it and with which
  message, its main owner and their share, how many people have contributed, its
  bus factor, and whether the owner is still active.
- **Activity.** Commits, churn, heat, age and a 24-month sparkline.
- **Architect's notes.** Rule-based suggestions, each stating the rule that
  fired: hotspot rank, the longest definition to split out first,
  branch-heavy code, the cycle's other members (click to fly), knowledge risk,
  possible dead code, undocumented bulk, and co-changed files, with pairs that
  cross a folder boundary called out as hidden coupling.

Clicking a raised plinth or a district plate opens the same report for that
folder: its contributors, bus factor and hotspot, oversized, cycle, dead-code and
owner-gone counts.

### Structure, ownership, tests and change

The first layer of signals says what is wrong with a *file*. The next layer is
about the *parts* and about *direction over time* — what an architect needs to
keep a repository healthy for years rather than for a sprint.

**Dependencies between parts.** Select a building and its resolved imports are
drawn as utility lines: blue to what it imports, amber from what imports it, red
for an import that breaks the layering, and teal rings around the files that
keep changing in the same commits. Select a district and arcs join it to the
folders it depends on, is depended on by, and changes together with — and every
building outside it fades, so the folder stands out without leaving the city.
Only the selection is ever drawn: the whole graph at once is the tangle the
original skybridges were removed for.

Every folder gets Robert C. Martin's afferent and efferent coupling (Ca: files
elsewhere that import something here; Ce: files here that import something
elsewhere) and **instability** I = Ce / (Ca + Ce): 0 is a foundation that should
change rarely, 1 a leaf that can change freely. The instability lens paints it
per file. City Hall carries the **dependency structure matrix** of the busiest
folders, ordered from leaves to foundations, so a clean layering sits above the
diagonal and a cell below it is an import pointing the wrong way.

**Layering rules.** A `.zion/rules.json` (or `zion.rules.json`) in the analyzed
repository — read, never written — declares the intended architecture:

```json
{
  "layers": ["web", "app", ["domain", "model"], "infra"],
  "forbid": [["domain", "web"], {"from": "lib/**", "to": "app/**"}]
}
```

`layers` runs top to bottom: a file may import its own layer or any layer below.
`forbid` lists pairs that must never be imported. Without a rules file, a folder
pair that imports both ways is a folder-level cycle and the thinner direction is
reported as the edge to cut.

**Who to ask, and whether CODEOWNERS still says so.** Each file and folder names
its experts: authors ranked by the lines they added, halved for every six months
since they last touched it, so a maintainer who is here today outranks a founder
who left. A `CODEOWNERS` file is checked against the history: when the people it
names commit to the repository but wrote almost none of a file, the declared
owner has drifted. Teams cannot be resolved from git and are never called
drifted. The **territory** lens paints one author's share of every building.

**Tests.** A test is linked to the sources it imports, and to the source its
name points at (`test_layout.py`, `layout_test.go`, `layout.test.ts`,
`LayoutTest.java`) in the same language. An untested file that is also a hotspot,
oversized or downtown gets traffic cones. The signal switches itself off when no
test can be linked at all, rather than painting a repository untested because
the heuristics cannot read its tests.

**Change over time.** Every build writes a small `summary.json` next to the city
(keyed by an HMAC of each path in an encrypted build, so it leaks nothing), and
the next build into the same directory compares itself against it — or against
any revision with `--compare REV`, analysed from `git archive` in a temporary
directory without touching the working tree. Changed files carry survey stakes;
the Health tab shows the before/after totals and what became a hotspot, joined a
cycle or broke a rule; the delta lens and `is:added` / `is:grown` / `is:shrunk`
find them. The **History** slider (and its play button) rebuilds the city as it
stood on any day of its history, each file appearing on the day of its first
commit.

**Views and notes.** *Copy view link* puts the exact view on the clipboard —
camera, filter, lens, selection and History date — so a finding can be pasted
into a pull request or a design doc. Notes on buildings are kept in the browser,
pinned on the map, listed in the Health tab and exported or imported as JSON.

**The report and the gate.** `zion.py report` prints the same findings as
Markdown (or JSON): totals against the baseline, hotspots, oversized files,
cycles, layering violations, untested risk, knowledge risk, branch-heavy code,
CODEOWNERS drift, possible dead code, folders that change together and a per-folder
table of Ca, Ce, instability, bus factor, test links and who to ask.
`--fail-on` makes it a CI gate: `cycles` (any now), `violations-up` (the total
rose against the baseline), `new-hotspot` (a file became one). A condition that
needs a baseline and has none is reported as not evaluated, never as passed.

### Why height is never bytes on disk

Because bytes on disk lie about code, in both directions.

This repository contains no notebooks, but the principle is easy to demonstrate
anywhere: a notebook that is 4 MB on disk can hold 100 lines of real code, the
rest being base64 chart output. Zion parses cell source and ignores outputs
entirely — a fixture test builds a notebook with a 400 KB base64 PNG and three
lines of code, and asserts its height comes from the three lines.

The other direction is worse in practice. From the large reference repository:

| File | On disk | Logical rows |
|---|---|---|
| `assets/data/llm-bpe-vocab.json` | 116,769 bytes, **zero newlines** | 1,565 (the length of its largest array) |
| `assets/data/llm-word-vectors.json` | 98,552 bytes, **zero newlines** | 396 |

Line counts give 0 or 1 for both. Row counts give a tall silo and a shorter one,
which is the truth. Data files are therefore streamed and measured by logical
rows, and never fully loaded into memory.

See [docs/VISUALIZATION_ROADMAP.md](docs/VISUALIZATION_ROADMAP.md) for planned visualizations —
new-vs-old, hot-vs-stable, a "downtown", nested folders, slicing/filtering, and detail windows.

---

## Degenerate data must not look broken

Most repositories are not a healthy multi-author project with years of history.
The two reference repositories here have **one author each**, **one distinct
commit date each**, and one of them is a single commit that touched all 357 files.

Rather than drawing a one-entry scale, the viewer drops the legend entry and says
so:

| Metric family | Enabled when | Effect when disabled |
|---|---|---|
| authorship, Mayor, author tint | ≥ 2 distinct authors | neutral palette; City Hall prints *"Single author — mayor system disabled"* |
| weathering / recency | ≥ 3 distinct commit dates | uniform weathering |
| churn cranes / rooftop beacons | ≥ 5 commits and a commit touching ≥ 2 files | no cranes, no beacons |
| co-change pairs | ≥ 2 coupling-eligible commits and ≥ 1 shared pair | no pairs listed, with the reason stated |
| layering violations | imports resolved and at least one points against the layering | no signs; *"No import points against the layering"* |
| untested risk | at least one test linked to a source file | no cones, with the reason stated |
| CODEOWNERS drift | a `CODEOWNERS` file with rules | no notices |
| changed since baseline | a previous build in the output directory, or `--compare REV` | no stakes; the Health card is absent |
| History slider | ≥ 2 distinct birth days among tracked files | the slider is hidden |

**The bulk-commit rule.** `interactive-courses` has exactly one commit, touching
357 of 357 files. Naive co-change coupling on that commit is a *complete graph*:
63,546 pairs. A commit is therefore coupling-eligible only if it touched
fewer than `max(8, min(0.2 × tracked_files, 200))` files. On the same rule,
`macro-harness` keeps two eligible commits and produces **exactly one**
co-change pair (`README.md` ↔ `pyproject.toml`), which is a real relationship.

The honest headline for both reference repositories is the same, and the tool
says it plainly: **1 of 4** districts and **1 of 30** districts have a README, and
that one is the repository root in each case.

---

## Using the city

| Input | Effect |
|---|---|
| `W` `A` `S` `D` | move (fly, or walk on foot) |
| `Q` / `E` | fly down / up |
| mouse | look (click once to capture the pointer; `Esc` releases) |
| `V` | toggle fly ⇄ walk |
| `O` | orbit: circle the city (or whatever you clicked) |
| `P` | plan view: straight down, north up, a long lens; drag or `W` `A` `S` `D` pans, wheel or `Q` `E` zooms, `R` frames the whole city |
| `M` | fold / unfold the minimap |
| `E` | enter the building you are facing, or City Hall when you are standing at it |
| `U` | unlock an encrypted city |
| `[` `]` | change floor while inside a building |
| `T` | guided tour: one continuous route, holding at each district with a caption |
| `N` | skip to the next stop during the tour |
| `C` | City Hall |
| `L` | toggle the City Guide (same as the title-bar button) |
| History slider / ▶ | the city as it stood on any day of its history |
| *Copy view link* | a link to exactly this view: camera, filter, lens, selection, date |
| drag | look around (the cursor stays visible) |
| click | inspect the building you are pointing at |
| `F` | capture the mouse for continuous flying (crosshair appears); `Esc` releases |

**Hover tells you what is clickable — and everything on the map is clickable.**
Because districts are folders and buildings are files, both are targets:

| Under the cursor | Highlight | Click opens |
|---|---|---|
| a building | brightens, outline snaps to it, lit windows jump | that file's inspector |
| a district block (or its distant impostor) | the whole block is outlined and every building in it tints amber | that folder's inspector |
| City Hall | outline + tooltip | the repository report card |

The cursor becomes a pointer and a tooltip names the thing with its numbers
(`folder · 10 buildings · 1,231 lines · no README`, or
`tower · python · 191 logical lines · 23 floors · click to inspect`). Hover and
click share a single raycast, so what lights up is exactly what opens — asserted
in the self-test rather than assumed. At scale the raycast is rate-limited (about
7 passes a second at 20,000 resident buildings), because testing every instance
is the one interactive cost that grows with city size.

**The tour holds, and shows you what it is describing.** It flies one continuous
closed route through the districts, and at each stop it *stops* — the dwell is as
long as the travel leg, so each stop gets twice the time of simply passing
through. While it holds, the district being described is marked on the ground and
**every building in it lights up amber**, the caption gives that district's
numbers, and a progress bar shows how far along the circuit is. Press `N` to skip
ahead. Cities with more than 32 districts are sampled evenly, and the label says
so rather than silently dropping most of the map.

**The minimap is always there.** A small map in the bottom-right corner draws the
whole plan -- region plinths, roads by class, district plates, City Hall -- from
the manifest, so districts that have not streamed in are on it too. Plates and
buildings are tinted by the **active colour lens** (the same function paints the
city and the map), the **filter's matches** are bright dots, the **selection** is
ringed, and files carrying one of **your notes** have a pink pin. The camera is a
view cone, or in the plan view the rectangle of ground on screen; when it
stands outside the city the marker is pinned to the map's edge. **Click to fly
there**, drag to scrub the view across the city, Shift-click to frame a whole
folder, and use the wheel or `+` / `−` to zoom the map, which then follows the
camera. `M` or the corner button folds it to a pill, and the choice is
remembered (it starts folded on narrow screens).

**The plan view reads the city as a map.** `P` (or *Plan view* in the title
bar) rises from wherever you are to a camera straight above the point you were
looking at, north up, through a 28° lens so towers do not lean out of frame and
hide their neighbours. Fog is pushed back by the altitude while it is up.
Picking still works (click a building to inspect it), minimap clicks glide the
plan instead of dropping out of it, and a *Copy view link* taken in the plan
reopens in the plan. `P` again hands the exact vantage back to free flight,
still looking down, so nothing jumps.

**City Hall** is the one building that is not a file: it is the repository's own
report card, standing at the centre of the plan on a plaza the districts are laid
out around rather than over. It carries the language
breakdown, the documentation coverage, the district table and the largest files,
and **clicking any row flies you to that building**.

**Interiors** are built when you enter and destroyed when you leave, at most two
cached. Each floor shows the source the parser actually measured — sliced by byte
offset out of the building's own source blob, so what you read is exactly what
produced the height. A notebook's interior shows cell source, not the `.ipynb`
wrapper.

**Day/night** is the metaphor made visible. At noon the city is lit plainly so the
data reads as geometry. At dusk the only windows glowing are the documented
buildings, so *lit = documented* is legible in one glance. There is a slider for
both.

**The filter bar is a zoning map.** Type `ext:py`, `name:CLAUDE.md`, `is:test`,
`loc>500`, `is:hotspot`, `is:cycle` or `-is:doc` into the Filter tab of the guide, and every
non-matching building fades to ghost grey while the count, total lines and
district spread of the match are reported live. `district:analyzer`,
`owner:ada`, `imports:analyzer/health.py` (files that import it),
`importedby:zion.py` (files it imports), `cx>=15`, `fanin>10`, `fanout>5` and
`delta>50` reach the structure; `is:violation`, `is:untested`, `is:untestedrisk`,
`is:braced`, `is:drift`, `is:unowned`, `is:added` and `is:grown` the new signals;
`OR` joins alternatives (`is:hotspot is:untested OR is:cycle`). The chips underneath fill it
for you from the repo's own top languages, archetypes and special files
(READMEs, `CLAUDE.md`, license, `Dockerfile`, CI configs). A colour-by dropdown
next to it re-tints the whole city by archetype, health, language, author, era,
heat, centrality, instability, test links, branchiest function, change since the
baseline, or one author's territory; the key under it counts the buildings on
screen in each band.

**New buildings wear scaffolding.** A file born in the newest slice of the
repo's own history (at least 30 days, or the newest 10% of its lifetime,
whichever is longer) is wrapped in a lattice, so recent additions are visible
without opening a diff. The colour lens also has an "age (era)" option
(brick → concrete → glass, oldest to newest) and a "recent activity (heat)"
option (grey → amber → red), both computed relative to the repo's own history,
never wall-clock time.

**Downtown** is the top slice of a composite centrality score -- co-change
degree, import in-degree (best-effort, from Python's `ast` or a relative-path
regex for JS/TS), recent activity and how many people have touched the file --
rendered as a glass tint and an antenna. A district whose downtown density is
at least twice the city's own average is a CBD, called out in its inspector
and detail report.

**"Open details"** on any building or district's inspector panel opens a report
window (a new tab, or an in-page overlay in a `--single-file` build) with the
full metric set, its floors, its co-changed files, and — for a district — its
largest files, each one click away from flying the main view to it.

---

## Encryption (opt-in)

```
ZION_PASSPHRASE='…' python3 zion.py build /path/to/repo --encrypt
```

Every name, path, author, docstring, statistics label and source body becomes
real AES-256-GCM ciphertext. **Geometry is untouched**, so the skyline is
byte-identical to the plain build — verified, not asserted: a district chunk
compares equal as a file, and a browser test unlocks the city and checks that no
building moved.

- PBKDF2-HMAC-SHA256, 310,000 iterations, 16-byte random salt, 256-bit key
- AES-256-GCM, fresh 96-bit IV per record, 16-byte tag appended to the ciphertext
- The record id is authenticated as additional data, so a record cannot be moved
  to another building
- Salt and iteration count live in `city.json`; records are framed `ZIONENC1` +
  IV + ciphertext + tag, which is the layout WebCrypto's `decrypt` expects
- Locked buildings show **deterministic procedural addresses** derived from
  `HMAC(salt, building_id)` — *"85 Kessler Court"* — which needs no passphrase,
  because it is not a secret

The legend stays readable while locked, deliberately: it describes what the city
*means*, which is public schema. Notes and statistics describe the repository, so
they stay encrypted.

### Why the cipher is written out by hand

`cryptography` is **not installed** in this environment, and OpenSSL's `enc`
subcommand has no AEAD support at all, so it can neither produce nor verify a GCM
tag. Node's AES-GCM is roughly a thousand times faster, but using it would make
the *analyzer* depend on Node — and the analyzer's whole promise is `python3
zion.py build <repo>` with nothing but the standard library. So
`vendor/aes_gcm.py` implements AES-256 and GCM directly, and is pinned to
published vectors: FIPS-197 for the block cipher, and NIST GCM test cases 13, 14
and 16 (including the 64-byte case with its exact expected tag). A cipher that
merely round-trips with itself can still be wrong; these it cannot.

Interiors carry full source, so encryption covers megabytes. The pure-Python
cipher runs at ~0.44 MB/s, so records are encrypted across processes:
`interactive-courses` (11.3 MB of source) encrypts in **0.62 s** on 8 cores.

---

## Scale

Measured, not estimated — see `bench/results.md`.

| | `macro-harness` | `interactive-courses` | synthetic 50k |
|---|---|---|---|
| Files | 28 | 357 | 50,013 |
| Districts | 4 | 30 | 320 |
| Build time | 0.25 s | 2.3 s | 41 s |
| **Draw calls** | **10** | **9** | **18** |

**Draw calls do not grow with building count.** One `InstancedMesh` exists per
archetype per LOD tier, so 28 buildings and 20,000 resident buildings cost the
same handful of calls. Per-building differences — footprint, height, tint, the
fraction of lit windows, the storey height, the facade family, the weathering
and the seed that decides the roofline — ride in the instance matrix, the
instance colour, and six instanced attributes.

**Detail does not grow them either.** Buildings are unique in three ways, none
of which costs a call. Each archetype has its own massing (`viewer/js/shapes.js`,
its assemblies under `viewer/js/parts/`) — podium, shaft, setback, crown — and
the vertex shader moves the ornament of that massing per instance, so a district
of towers is a skyline rather than a comb. Each wall is computed per fragment from
the building's own metrics (`viewer/js/facade.js`) rather than sampled from one
shared bitmap, so window rows *are* the floors the parser found: a three-function
module gets three rows and a forty-class one gets forty. And the whole city's
rooftop plant, tanks and masts are a single extra instanced cluster.

The facade antialiases itself with screen-space derivatives, dissolving into the
average it would have integrated to once a window cell drops below a pixel —
which is what lets a ten-thousand-building skyline carry window-level detail
without shimmering. "Lit means documented" survives that averaging, because the
average of the per-window dice roll *is* the building's documented ratio.

Three mechanisms keep a big city finite:

1. **Chunk streaming.** A camera-centred working set, bounded in metres and then
   capped by building count. The 50k benchmark holds 19,880 of 50,013 buildings
   across 129 of 320 chunks.
2. **Level of detail.** Distant buildings keep their facade and their glow — the
   metaphor has to survive at range — but fall back to box massing, which is
   where the triangles actually go. The detailed tier is bounded by radius and
   then by count, so a dense repository degrades gracefully instead of all at
   once.
3. **L3 district impostors.** Every district that is *not* resident is drawn as a
   single box sized from the manifest's own skyline envelope, so streaming leaves
   no hard edge at the horizon — for one extra draw call no matter how many
   districts are missing.

Analysis, layout and geometry all happen in Python. The viewer never parses
source; it receives numbers.

---

## Adaptive layout

Districts are folders at an automatically chosen depth, and the choice matters
more than it sounds:

| Depth | `interactive-courses` | Verdict |
|---|---|---|
| 1 | 11 districts, one holding 135 files | too coarse |
| **2** | **30 districts, none a single building** | **chosen** |
| 3 | 269 districts, 268 with one building each | not a city |

The rule takes the depth with the most structure whose district count lands in a
readable band, preferring depths that produce no single-building district, and
breaking ties toward the shallower depth. The band widens for large repositories
(a fixed ceiling of 64 would describe a 50,000-file repository with eight
enormous districts). `--district-depth` overrides it.

Street geometry falls out of the treemap: each subdivision line is where a street
goes, so blocks and roads are the same decision rather than two.

**The treemap is nested, so the folder tree is visible on the ground.** The chosen
depth decides the *leaf* districts, as before. Above them, every folder that splits
into more than one piece becomes a region on its own raised plinth, and the roads
between siblings narrow with depth:

- **highways** between top-level folders and around City Hall
- **avenues** inside a top-level folder
- **streets** one level deeper
- **alleys** below that

The width of a road is therefore how far apart two neighbourhoods are in the tree.
A folder with a single child passes its ground straight through, with no road and
no plinth, so `src/main/java/com/acme` costs nothing. The plaza, the frame and the
band assignment still run once, over the top-level folders only. Road area is
budgeted up front, so the nesting does not shrink the buildings, and road widths
scale down on small plans so a small repository is not all tarmac.

**City Hall's plaza is reserved ground, not a building dropped into a block.** The
treemap is never handed the middle of the plan: the plan is framed around a central
reserve, districts are dealt into the four bands by weight, and an avenue rings the
open square. A treemap covers whatever rectangle it is given, so the only way to
guarantee the landmark is not standing inside somebody's district is to leave that
rectangle out of the layout altogether — which is also why the plaza is capped as a
share of the plan, and the hall scaled down to fit it rather than the other way
round. The hall's position and size are emitted in the manifest, so the massing in
the viewer and the ground the analyzer kept clear cannot drift apart.

---

## What is deliberately not done

- **Brace-family parsing is heuristic.** `js/ts/java/go/c/cpp/cs/rs/kt/swift/php/scala`
  are scanned with a string-and-comment stripper, brace-depth tracking and
  depth-based declaration regexes. That is enough for floor counts and comment
  ratios and is **not** trustworthy for anything semantic. Results are marked
  `confidence: "medium"` and the inspector says so.
- **Notebooks are fixture-tested only.** Neither reference repository contains
  one, so that parser is proven by tests, not by a demo.
- **Town Halls are fixture-tested only** for the same reason: no district in
  either reference repository has its own README.
- **Frame times are not published from headless runs.** Chrome's
  `--virtual-time-budget` freezes the clock during a synchronous render loop, so
  `performance.now()` deltas come back as exactly `0`. The benchmark reports
  `frameP50: null` and a `timingMode` instead of a flattering fiction. Draw calls
  and resident counts are the deterministic gates.

---

## Opening a city without a server

`file://` cannot fetch, and streaming needs `fetch()`, so these two requirements
cannot both hold in one artifact. Zion ships both halves honestly:

- `zion serve <repo>` is the normal path: full streaming, full scale.
- `zion build <repo> --single-file` inlines the viewer, three.js, all city data
  and the CSS into one `city.html` that opens by double-click. The gate is
  size-based, because base64 inflates the payload by a third:

  | Repository | Result |
  |---|---|
  | `macro-harness` | 2.1 MB single file |
  | `interactive-courses` | 19.2 MB single file |
  | synthetic 50k | **refused**, with the reason printed |

A single HTML document at 50,000 files would have to parse tens of megabytes
before the first frame. It is not a limitation to work around; it is the
trade-off stated plainly.

---

## Encryption + single file together

`--encrypt --single-file` produces one self-contained file whose labels are
ciphertext: it renders the skyline immediately, and needs the passphrase before
any name appears. This is the natural artifact to share.

---

## How it is verified

```
python3 -m unittest discover -s tests -p 'test_*.py'     # 74 tests, stdlib only
```

**Analyzer.** Golden tests build a committed fixture repository of known shape and
assert its city: four districts, a Town Hall in `alpha` and not in `beta`, a park
for `tests/`, a silo for the CSV, a notebook interior containing `math.pi` and
**not** the base64 blob, floor slices that equal the original source lines, and
flags computed from the degeneration rules. A layout test asserts what the picture
is supposed to show: that no district and no building stands on the City Hall
plaza, that the hall fits inside the reserve, and that every plan size from 60 m to
3.2 km still keeps ground for districts on all four sides.

**The reference repositories**, whose numbers are cited throughout this README:

```
python3 zion.py stats /Users/denimpatel/Desktop/git/HARNESS/macro-harness
  -> 28 files, 53 hidden by .gitignore, 3,066 physical Python lines in 22 files,
     4 districts at depth 1

python3 zion.py stats /Users/denimpatel/Desktop/git/interactive-courses
  -> 357 files, 361 hidden by .gitignore (the whole generated _site/ tree),
     30 districts at depth 2, 152,491 physical HTML lines across 284 files
```

`.gitignore` handling is not reimplemented. The walker asks git for the
authoritative answer with `git ls-files -z --cached --others --exclude-standard`
— one subprocess, 29 ms on the larger repository, and correct for nested
`.gitignore` files, negations, anchors and `**` patterns. Without it,
`interactive-courses` doubles (718 files instead of 357) and `macro-harness` is
mostly cache files (81 instead of 28). `--include-noise` walks the filesystem
instead and renders the excluded set as ruins.

**The viewer** is verified by a scripted pass through every interactive surface,
because "it renders" is not the same as "it works":

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
  --headless=new --no-sandbox --enable-unsafe-swiftshader \\
  --virtual-time-budget=60000 --dump-dom "http://127.0.0.1:PORT/?selftest=1"
```

which returns `ZION_SELFTEST {…}` containing 73 checks: walk gravity (simulated
until the player actually comes to rest on a surface), a collision test that
drives the player into a building and asserts they stop outside it, drag-to-look
rotating the camera without capturing the pointer or opening the inspector, a
click on a building's projected position opening it, hover reporting the same
building that the click then acts on, interior floors and source, an interior
wall texture confirmed to contain rendered text, City Hall's clickable rows,
teleport, the tour and its caption, hover/click agreement, district hover and
district click, the tour's dwell share and district highlight, the City Guide
covering every legend entry with its switches actually reaching the geometry, a
guide row expanding into its explanation and highlighting its buildings, one road
mesh per road class and one plinth per region, the inspector explaining a
building's floors with its architect's notes, the health lens and Health tab, and
that the level of detail follows the camera (fly past the LOD radius and the
nearest building must be in the near tier, not a far-tier box), the hover
pipeline surviving every target kind it can be handed (a region, which crashed
the outline pass), and the draw-call budget.

`--enable-unsafe-swiftshader` is required. Without it, headless Chrome reports
`NO_WEBGL` and renders nothing, which is a silent failure rather than an error.

**The HUD itself** needs eyes, not assertions: contrast is the one property none
of those 73 checks measures. Chrome's `--screenshot` flag cannot capture this
viewer at all — the frame loop never lets `--virtual-time-budget` expire, so the
process hangs — so `tests/capture.py` drives Chrome over the DevTools Protocol,
waits on wall-clock time, and runs a snippet before capturing (opening the
inspector on a real building or district, driving the clock to night, changing
the viewport):

```
python3 tests/capture.py --url http://127.0.0.1:8791/ --out /tmp/hud.png --js
python3 tests/capture.py --url http://127.0.0.1:8792/ --out /tmp/hud.png --js --district
```

**The landmark** gets the same treatment from `tests/capture_hall.py`, which
reads `manifest.cityHall` and places the fly camera on an orbit around it, so the
hall is framed the same way whatever plan it stands on:

```
python3 tests/capture_hall.py --url http://127.0.0.1:8791/ --out /tmp/hall.png
python3 tests/capture_hall.py --url http://127.0.0.1:8791/ --out /tmp/hall-front.png --dist 62 --eye 16 --angle -1.5708 --look-y 9
```

`--dist` and `--eye` are in multiples of the hall's own scale and `--angle`
orbits it (`-1.5708` is dead ahead of the portico), so the massing can be
inspected from the street, the hero angle or above without flying there by hand.
The short repo is often enough to iterate on the design; the same invocation
frames it in `deepseek-harness` at ten times the scale.

Both are developer tools: not part of the suite (the `test_*.py` pattern never
collects them) and not part of the viewer. The one dependency beyond the standard
library is `websocket-client`, needed only to speak CDP.

**Encryption** is verified from both ends. In Python: NIST vectors, a tampered
ciphertext and a tampered tag both rejected, additional data actually
authenticated, district chunks byte-identical between the plain and encrypted
builds, and no label leaks into the manifest or the chunks. In the browser: the
locked city shows procedural addresses, WebCrypto decrypts the ciphertext Python
produced, real labels replace them in place, and a geometry fingerprint over the
resident buildings is unchanged across the unlock.

One honest caveat: a 310,000-iteration PBKDF2 promise **never settles** under
Chrome's virtual clock, and a real-clock `--dump-dom` has a deadline shorter than
the viewer's boot. The browser test therefore installs an already-derived key
through a documented `useRawKey` path, which exercises the entire decryption
chain; PBKDF2 itself is verified against the manifest parameters in Python. The
user-facing flow always derives the key in the browser.

**The 50,000-file proof** is reproducible:

```
python3 bench/generate_repo.py bench/tmp/repo-50000 --files 50000 --commits 40
python3 zion.py build bench/tmp/repo-50000 -o /tmp/zion50k
# then serve it and read ?bench=1, or ?selftest=1
```

---

## Repository layout

```
zion.py                  CLI: build | serve | stats | bench
analyzer/
  walk.py                git-first file enumeration
  parse/                 python_ast · notebook · brace · markup · tabular
  gitmeta.py             one `git log --numstat` pass → authorship, churn,
                         recency, co-change coupling
  metrics.py             per-file metrics, confidence and degeneration rules
  health.py              architect's signals: hotspots, knowledge risk,
                         oversized, orphans, import cycles
  layout.py              district depth rule, nested treemap, road classes,
                         region plinths, building grid
  crypto.py              AES-256-GCM + PBKDF2, WebCrypto-compatible framing
  emit.py                manifest, chunks, floor detail, string table, inlining
viewer/
  index.html · css/hud.css
  js/  main · loader · city · stream · interior · cityhall/tour · cameras
       · collision · inspector · labels · minimap · sky · vault
       parts/ massing · civic · construction · parks · beacons · health
vendor/                  three.module.js (pinned, with provenance) · aes_gcm.py
tests/                   105 stdlib tests + committed fixture repositories
bench/                   synthetic repository generator and measured results
```

**Nothing is committed as a generated demo city.** Both example repositories live
outside this one and are analyzed by path on demand, so a fresh clone contains
code and tests rather than a stale snapshot of somebody else's skyline.

---

## Assumptions and limits

- The reference repositories are read-only inputs and are never modified.
- `--include-noise` is the only way to see ignored files, and it renders them as
  ruins rather than as ordinary buildings, because they are not project content.
- Buildings are placed on a grid inside treemap districts; a very deep directory
  tree is truncated at the chosen district depth rather than exploding.
- Interiors carry full source by explicit choice. The city is therefore roughly
  the size of the repository it describes — 11.3 MB of source for an 11.8 MB
  repository — which is why the single-file gate is size-based.
