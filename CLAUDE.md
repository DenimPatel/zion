# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zion turns a repository into an explorable 3D city: folders → districts, files → buildings, top-level
functions/classes/headings/cells → floors. Pure Python standard library on the analysis side; the viewer
is vanilla JS + a vendored `three.js`, no build step, no `npm`/`node_modules`.

## Commands

```
python3 zion.py stats  /path/to/repo        # text report, no build artifacts
python3 zion.py build  /path/to/repo [-o DIR] [--district-depth N] [--include-noise] [--encrypt] [--single-file]
python3 zion.py serve  /path/to/repo        # build if needed, serve, open a browser
python3 zion.py report /path/to/repo [--format md|json] [--compare REV] [--baseline summary.json] [--fail-on LIST]
python3 zion.py build  /path/to/repo --compare REV   # delta against a revision instead of the last build
python3 bench/generate_repo.py bench/tmp/repo-50000 --files 50000 --commits 40   # synthetic repo for scale testing
```

Tests (152 tests, stdlib only, no test runner dependency):

```
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest tests.test_layout                 # single module
python3 -m unittest tests.test_golden.GoldenTest.test_town_hall_flags   # single test
```

`tests/capture.py` is a developer tool for screenshotting the HUD via the Chrome DevTools Protocol
(needs `websocket-client`); it is **not** collected by `test_*.py` discovery.

Headless viewer self-test (100+ interactive checks on a plain city, more when encrypted; dumps `ZION_SELFTEST {…}` JSON):

```
"/path/to/Chrome" --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --virtual-time-budget=60000 --dump-dom "http://127.0.0.1:PORT/?selftest=1"
```

`--enable-unsafe-swiftshader` is required or Chrome reports `NO_WEBGL` and renders nothing. For an encrypted city pass
`&rawkey=<base64url key>` (derive it with `analyzer.crypto.derive_key` and the manifest's salt): `&pass=` runs the
310k-iteration PBKDF2 in the page, which never settles under the virtual clock. `tour-no-jumps` also fails headless on
the unmodified tree (virtual-time frame pacing).

Encrypted build: `ZION_PASSPHRASE='…' python3 zion.py build /path/to/repo --encrypt`.

## Architecture

**Pipeline (all Python, all in `analyzer/`):** `walk.py` → `gitmeta.py` → `metrics.py` (→ `health.py`, `owners.py`,
`testmap.py`, `deps.py`, `clones.py`) → `layout.py` (→ `architecture.py`) → `history.py` + `crypto.py` (if `--encrypt`) → `emit.py`; `report.py`
renders the same analysis as Markdown/JSON for `zion.py report`. The viewer never parses source — it only receives numbers
(the manifest + chunk JSON emitted by `emit.py`). `zion.py` is the CLI that wires this pipeline together
for `stats`/`build`/`serve`/`bench`.

- `walk.py` — file enumeration via `git ls-files -z --cached --others --exclude-standard` (one subprocess
  call); `.gitignore` semantics are never reimplemented. `--include-noise` switches to a filesystem walk
  and marks excluded files as ruins instead of buildings.
- `gitmeta.py` — one `git log --numstat` pass produces authorship, churn, recency, and co-change coupling
  for every file in a single pass (not one call per file), plus per-file fix and revert commits from the subject line.
- `analyzer/parse/` — per-language floor/line extraction: `python_ast` (real AST), `notebook` (cell source
  only, ignores base64 outputs), `brace` (heuristic string/comment-stripping + brace-depth tracking for
  js/ts/java/go/c/cpp/cs/rs/kt/swift/php/scala — marked `confidence: "medium"`, not semantically trustworthy),
  `markup` (headings), `tabular` (streamed row counts for data files — never fully loaded into memory).
- `metrics.py` — turns parsed files into per-file metrics, confidence, and the "degeneration rules" that
  disable a legend entry (authorship/mayor, weathering, churn cranes, co-change skybridges) when the repo's
  history is too degenerate to support it (e.g. single author, single commit date).
- `health.py` — the architect's signals, from numbers `metrics.py` already has: first/last author, bus
  factor, owner-inactive knowledge risk, hotspots (commit frequency × size), oversized files, orphan
  candidates and import cycles (iterative Tarjan), blast radius (`impact`: exact transitive importers via SCC
  condensation + int bitsets -- never a per-file BFS, which is quadratic on a long chain), bug-prone files (fix
  commits) and debt markers (TODO/FIXME/HACK/XXX, counted by the parsers inside comments only). Also the deeper
  signals: defect-prone files (share of commits whose subject matches `gitmeta.FIX_RE`), trend (last quarter vs
  the one before, rising hotspots), hubs (top decile fan-in *and* fan-out), import depth (longest chain on the
  cycle-collapsed graph, iterative). Each gated on its own flag (`hotspots`, `knowledge`, `imports`, `defects`,
  `trend`, `hubs`, `debt`); vendored paths are excluded.
- `clones.py` — clone twins: `parse_text` fingerprints code (normalised lines, winnowed k-grams) into
  `ParseResult.fingerprints`; `finalize_clones` pairs files through an inverted index and then empties the
  fingerprints. Tests and vendored code never pair.
- `grades.py` — A–F per folder/region/city from the named `history.SIGNALS` of its files (sqrt-of-lines
  weighted, fixed cuts), and the same grade recomputed from the baseline summary's bits.
- `architecture.py` — dependency structure between leaf districts, run at the end of `build_layout` (it needs districts):
  per-folder Ca/Ce/instability, abstractness and distance from the main sequence (zone of pain / uselessness), the
  folder matrix, layering violations (from a read-only `.zion/rules.json` / `zion.rules.json` with `layers`/`forbid`,
  else "the thinner direction of a folder pair that imports both ways"), building codes (`codes` in the same file:
  per-file limits, checked whether or not imports resolved), cross-folder co-change, file-level hidden coupling
  (co-change across folders with no import either way), and per-folder coordination cost (recent authors,
  cross-folder commit share, "many cooks"). Tests and vendored code are not design dependencies.
- `owners.py` — recency-weighted experts ("who to ask", half-life 180 days), author shares, and CODEOWNERS parsing
  (gitignore semantics, last match wins) with drift = the named individuals commit but did not write the file. Teams
  are never called drifted. Needs `gitmeta`'s author emails.
- `testmap.py` — links tests to sources by resolved import and by same-language name stem; `untested_risk` only for
  hotspot/oversized/downtown files and only when at least one link exists (`flags.tests`). Also `is_braced`
  (a *function or method* with ≥ 15 decision points — class totals are sums, not one definition).
- `deps.py` — external trade: unresolved Python imports (minus stdlib and the repo's own folder/module names) and
  bare JS/TS specifiers become package names, checked against `requirements*.txt`, `pyproject.toml`, `package.json`
  (read-only) for undeclared and unused packages. Only ecosystems whose imports the parsers collect are judged.
- `history.py` — `summary.json` per build (paths HMAC-keyed under `--encrypt`), the delta against the last build in
  the same output dir (or the one before it when the head did not move), and `analyze_revision` for `--compare REV`
  (`git archive` into a temp dir; never touches the analyzed working tree). `census.json` keeps the totals of the last 30
  builds (one per commit, counts only) for the Health tab's census sparklines.
- `layout.py` — chooses district depth (most structure within a readable district-count band, preferring
  no single-building district, ties toward shallower), then lays the leaf districts out as a *nested*
  treemap over their folder tree: each folder that splits becomes a region (raised plinth) and the roads
  between siblings get a class by depth (0 highway … 3 alley). Single-child folder chains collapse. The
  City Hall plaza, frame and band spreading run once, over the top-level folders only.
- `crypto.py` — AES-256-GCM + PBKDF2 (310k iterations), framed as `ZIONENC1` + IV + ciphertext + tag to
  match what WebCrypto's `decrypt` expects in the browser. Uses `vendor/aes_gcm.py` (hand-written,
  standard-library-only cipher pinned to FIPS-197 and NIST GCM test vectors) rather than `cryptography`
  (not available) or shelling out to Node.
- `emit.py` — writes the manifest, per-district chunks, floor detail, and (for `--single-file`) inlines
  the viewer + three.js + city data into one `city.html`.

**Viewer (`viewer/js/`, no framework):** `main.js` is the entry point/orchestrator; `loader.js`/`stream.js`
handle fetching and camera-centred chunk streaming (bounded by radius then building count); `city.js`
builds the instanced meshes (one `InstancedMesh` per archetype per LOD tier — draw calls don't scale with
building count); `shapes.js` is the registry of unit-normalised geometry, built from the shared
`primitives.js` kit and, for anything elaborate, an assembly under `viewer/js/parts/` (`massing.js`,
`civic.js`, `construction.js`, `parks.js`, `beacons.js`, `health.js`) — every form is a unit-space geometry with
podium/shaft/setback/crown part tags, so layout, collision and picking never learn which file it came
from; `facade.js` renders windows per-fragment from a building's own metrics (not a shared texture) so
window rows equal parsed floor counts; `interior.js` builds/destroys building interiors on enter/leave
(max 2 cached), slicing source by byte offset so displayed text matches exactly what was measured;
`labels.js` projects region/district names as DOM labels, revealed by camera distance per level;
`palette.js` is the Ctrl+K go-to finder over `index.json`; `selection.js::PlanFlows` draws the plan view's capped
folder arrows; `minimap.js` is the bottom-right 2D-canvas map (drawn from the manifest, tinted through `city.js::lensColour`,
click-to-fly via `main.js::miniMapNavigate`); `cameras.js::TopCamera` is the plan view (`P`, straight down,
north up, rotation set directly because `lookAt` is degenerate overhead);
`selection.js` draws what the current selection is connected to (import lines, co-change rings, the blast-radius flood map, hidden-coupling and clone arcs, district arcs) —
only for the selection, as its own scene group; `notes.js` (localStorage, keyed by repo name + path) and
`views.js` (URL-hash saved views) are the reader's own state; `parts/structure.js` holds the no-entry sign,
traffic cones, cross-bracing, survey stake, owner notice, note pin, smoke plume, potholes and code notice;
`inspector.js` is the explaining building/district/region report; `cityhall/`, `tour.js`, `cameras.js`,
`collision.js`, `sky.js` are self-explanatory;
`vault.js` handles client-side WebCrypto decryption of encrypted cities.

## Key invariants to preserve

- Building height is always **logical source lines** (or logical rows for data files), never bytes on
  disk — see the README's "Why height is never bytes on disk" section for the reasoning; don't reintroduce
  byte-size-based height.
- Degeneration rules in `metrics.py` must stay in sync with what `layout.py`/the viewer actually disable —
  a legend entry that is turned off must also stop rendering the related geometry (e.g. no cranes without
  churn eligibility).
- Level of detail is a function of the camera, not only of the resident working set. `refreshResident`
  in `viewer/js/main.js` must rebuild when the camera travels a fraction of `city.lodRadius`, because a
  repository under the resident cap keeps every district resident and the streamer then never reports a
  change — without that rebuild the near/far ranking would stay frozen around the opening camera and
  everything past it would keep its far-tier box (`lod-follows-camera` guards this).
- Vertex colours are only valid on the detailed tier. `farGeometry` is a plain box with no colour
  attribute, so a material with `vertexColors: true` renders it black — enable vertex colours as
  `detailed && …` (see `PAINTED` in `viewer/js/city.js`). Every near form is painted (massing forms by part tag
  via `primitives.js::paintByPart`, park/monument/town hall piece by piece via `paint` + `mergeColouredParts`),
  and the paint shows only under the `archetype` lens: `CityMesh.recolour` flips `material.vertexColors` off for any
  data lens so each building is one flat colour. Park and monument take a near-white base (`SELF_COLOURED`) under
  the archetype lens so their palette is not multiplied by their legend colour. A new form must be painted too.
- Drawn size is not measured size. `LANDMARK_SCALE` enlarges a civic form's massing on screen, so
  anything placed on it (props, cranes, beacons) must be positioned from the scaled dimensions, while
  collision, hover and the detail report keep the real footprint.
- The City Guide (`#guide`) is the legend made switchable: `LEGEND_KEYS` in `viewer/js/main.js` maps each
  manifest legend id to the layer it draws (`archetype`, `mesh` or `option`), its real on-screen colour and
  the filter query that counts/highlights its buildings. A new legend entry needs a row there *and* a
  `(id, label, unit, group, description)` entry in `emit.py::LEGEND_SPEC`; an entry with no separate layer
  is shown with an "always" badge, never as a dead switch.
- The City Guide's `#guide-lens` and the Filter tab's `#lens-select` are one lens (`main.js::applyLens` keeps
  them, the key and the city in step; its options are copied from `#lens-select`). A fresh page opens on the
  reader's saved lens or `language`; `?selftest=1` always opens on `archetype`.
- The city and the minimap colour through one function, `city.js::lensColour`. A new lens is added there, never
  copied into `minimap.js`.
- Relationships are drawn for the selection only (`viewer/js/selection.js`). Never draw every import or co-change edge
  at once — that is the tangle the original skybridges were removed for.
- `index.json` columns and `FLAG_*` bits are append-only; `viewer/js/facets.js::FLAG_BITS` must mirror `emit.py`
  (`test_deeper.ContractTests` checks it). `history.SIGNALS` is append-only too, and a signal a baseline never
  recorded is never reported as newly gained.
- Relationship partners (hidden coupling, clone twins, tested-by) are emitted as building ids, never paths, and
  debt-marker text goes through the string table, so nothing leaks under `--encrypt`.
- Nothing about the repository may reach `summary.json`, `imports.json` or `city.json` in plaintext under `--encrypt`:
  edges are building ids, summaries are HMAC-keyed, names go through the string table.
- Streets are `[x, y, w, h, class]` and regions carry `level`; anything drawn on the ground (district
  plates, roads, ground props) must sit on `plinthTop(level)` from `viewer/js/city.js`, or it is buried
  inside the plinth. Anything flat laid *on* a district plate needs real clearance above it (the selection overlay
  uses `GROUND_LIFT` = 0.3 m plus polygon offset): with a 0.5 m near plane a few centimetres z-fights away at range.
- Geometry must stay byte-identical between plain and encrypted builds; only labels/text change under
  `--encrypt`. Don't let `crypto.py` changes touch coordinates, sizes, or IDs.
- `analyzer/` must never write into the analyzed repo; output goes to `-o DIR` or the cache dir computed
  in `zion.py::cache_dir_for`.
- Nothing is committed as a generated demo city — don't add example `out/`/city artifacts to the repo.
