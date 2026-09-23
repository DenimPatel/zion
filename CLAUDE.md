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
python3 bench/generate_repo.py bench/tmp/repo-50000 --files 50000 --commits 40   # synthetic repo for scale testing
```

Tests (76 tests, stdlib only, no test runner dependency):

```
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest tests.test_layout                 # single module
python3 -m unittest tests.test_golden.GoldenTest.test_town_hall_flags   # single test
```

`tests/capture.py` is a developer tool for screenshotting the HUD via the Chrome DevTools Protocol
(needs `websocket-client`); it is **not** collected by `test_*.py` discovery.

Headless viewer self-test (40 interactive checks, dumps `ZION_SELFTEST {…}` JSON):

```
"/path/to/Chrome" --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --virtual-time-budget=60000 --dump-dom "http://127.0.0.1:PORT/?selftest=1"
```

`--enable-unsafe-swiftshader` is required or Chrome reports `NO_WEBGL` and renders nothing.

Encrypted build: `ZION_PASSPHRASE='…' python3 zion.py build /path/to/repo --encrypt`.

## Architecture

**Pipeline (all Python, all in `analyzer/`):** `walk.py` → `gitmeta.py` → `metrics.py` → `layout.py` →
`crypto.py` (if `--encrypt`) → `emit.py`. The viewer never parses source — it only receives numbers
(the manifest + chunk JSON emitted by `emit.py`). `zion.py` is the CLI that wires this pipeline together
for `stats`/`build`/`serve`/`bench`.

- `walk.py` — file enumeration via `git ls-files -z --cached --others --exclude-standard` (one subprocess
  call); `.gitignore` semantics are never reimplemented. `--include-noise` switches to a filesystem walk
  and marks excluded files as ruins instead of buildings.
- `gitmeta.py` — one `git log --numstat` pass produces authorship, churn, recency, and co-change coupling
  for every file in a single pass (not one call per file).
- `analyzer/parse/` — per-language floor/line extraction: `python_ast` (real AST), `notebook` (cell source
  only, ignores base64 outputs), `brace` (heuristic string/comment-stripping + brace-depth tracking for
  js/ts/java/go/c/cpp/cs/rs/kt/swift/php/scala — marked `confidence: "medium"`, not semantically trustworthy),
  `markup` (headings), `tabular` (streamed row counts for data files — never fully loaded into memory).
- `metrics.py` — turns parsed files into per-file metrics, confidence, and the "degeneration rules" that
  disable a legend entry (authorship/mayor, weathering, churn cranes, co-change skybridges) when the repo's
  history is too degenerate to support it (e.g. single author, single commit date).
- `layout.py` — chooses district depth (most structure within a readable district-count band, preferring
  no single-building district, ties toward shallower), builds the treemap, derives street geometry from
  treemap subdivision lines, and reserves the central City Hall plaza before districts are laid out.
- `crypto.py` — AES-256-GCM + PBKDF2 (310k iterations), framed as `ZIONENC1` + IV + ciphertext + tag to
  match what WebCrypto's `decrypt` expects in the browser. Uses `vendor/aes_gcm.py` (hand-written,
  standard-library-only cipher pinned to FIPS-197 and NIST GCM test vectors) rather than `cryptography`
  (not available) or shelling out to Node.
- `emit.py` — writes the manifest, per-district chunks, floor detail, and (for `--single-file`) inlines
  the viewer + three.js + city data into one `city.html`.

**Viewer (`viewer/js/`, no framework):** `main.js` is the entry point/orchestrator; `loader.js`/`stream.js`
handle fetching and camera-centred chunk streaming (bounded by radius then building count); `city.js`
builds the instanced meshes (one `InstancedMesh` per archetype per LOD tier — draw calls don't scale with
building count); `shapes.js` defines per-archetype massing (podium/shaft/setback/crown), `facade.js` renders
windows per-fragment from a building's own metrics (not a shared texture) so window rows equal parsed
floor counts; `interior.js` builds/destroys building interiors on enter/leave (max 2 cached), slicing source
by byte offset so displayed text matches exactly what was measured; `cityhall/`, `tour.js`, `cameras.js`,
`collision.js`, `inspector.js`, `sky.js` are self-explanatory; `vault.js` handles client-side WebCrypto
decryption of encrypted cities.

## Key invariants to preserve

- Building height is always **logical source lines** (or logical rows for data files), never bytes on
  disk — see the README's "Why height is never bytes on disk" section for the reasoning; don't reintroduce
  byte-size-based height.
- Degeneration rules in `metrics.py` must stay in sync with what `layout.py`/the viewer actually disable —
  a legend entry that is turned off must also stop rendering the related geometry (e.g. no cranes without
  churn eligibility).
- Geometry must stay byte-identical between plain and encrypted builds; only labels/text change under
  `--encrypt`. Don't let `crypto.py` changes touch coordinates, sizes, or IDs.
- `analyzer/` must never write into the analyzed repo; output goes to `-o DIR` or the cache dir computed
  in `zion.py::cache_dir_for`.
- Nothing is committed as a generated demo city — don't add example `out/`/city artifacts to the repo.
