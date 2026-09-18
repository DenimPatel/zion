# Zion

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
| size on disk, capped | footprint |
| top-level functions / classes / headings / notebook cells | floors |
| folder content weight | district area (treemap) |
| dominant author by lines owned | building tint, district Mayor |
| commits touching the file | window traffic; crane on top-decile churn |
| days since last commit | weathering: clean → grimy → derelict |
| docstring + comment ratio | **fraction of lit windows** |
| README in the folder | Town Hall landmark |
| test files | parks |
| data files | silos (height = row count) |
| binary artefacts | monuments |
| files changed together in one commit | skybridges |

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
| churn cranes | ≥ 5 commits and a commit touching ≥ 2 files | no cranes |
| co-change skybridges | ≥ 2 coupling-eligible commits and ≥ 1 shared pair | no bridges, with the reason stated |

**The bulk-commit rule.** `interactive-courses` has exactly one commit, touching
357 of 357 files. Naive co-change coupling on that commit is a *complete graph*:
63,546 skybridges. A commit is therefore coupling-eligible only if it touched
fewer than `max(8, min(0.2 × tracked_files, 200))` files. On the same rule,
`macro-harness` keeps two eligible commits and produces **exactly one**
skybridge (`README.md` ↔ `pyproject.toml`), which is a real relationship.

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
| `O` | top-down overview |
| `E` | enter the building you are facing, or City Hall when you are standing at it |
| `U` | unlock an encrypted city |
| `[` `]` | change floor while inside a building |
| `T` | guided tour: one cinematic stop per district with a caption |
| `C` | City Hall |
| `L` | hide the legend |
| click | inspect a building |

**City Hall** is the one building that is not a file: it is the repository's own
report card, standing at the centre of the plan. It carries the language
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
same handful of calls. Per-building differences — footprint, height, tint, and
the fraction of lit windows — ride in the instance matrix, the instance colour,
and one extra instanced attribute.

Three mechanisms keep a big city finite:

1. **Chunk streaming.** A camera-centred working set, bounded in metres and then
   capped by building count. The 50k benchmark holds 19,880 of 50,013 buildings
   across 129 of 320 chunks.
2. **Level of detail.** Distant buildings keep their glow but drop the window
   texture, which is the expensive part of the fragment shader.
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
python3 -m unittest discover -s tests -p 'test_*.py'     # 72 tests, stdlib only
```

**Analyzer.** Golden tests build a committed fixture repository of known shape and
assert its city: four districts, a Town Hall in `alpha` and not in `beta`, a park
for `tests/`, a silo for the CSV, a notebook interior containing `math.pi` and
**not** the base64 blob, floor slices that equal the original source lines, and
flags computed from the degeneration rules.

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

which returns `ZION_SELFTEST {…}` containing 26 checks: walk gravity, a collision
test that drives the player into a building and asserts they stop outside it,
interior floors and source, an interior wall texture that is confirmed to contain
rendered text, City Hall's clickable rows, teleport, the tour and its caption,
and the draw-call budget.

`--enable-unsafe-swiftshader` is required. Without it, headless Chrome reports
`NO_WEBGL` and renders nothing, which is a silent failure rather than an error.

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
  layout.py              district depth rule, treemap, streets, building grid
  crypto.py              AES-256-GCM + PBKDF2, WebCrypto-compatible framing
  emit.py                manifest, chunks, floor detail, string table, inlining
viewer/
  index.html · css/hud.css
  js/  main · loader · city · stream · interior · cityhall/tour · cameras
       · collision · inspector · sky · vault
vendor/                  three.module.js (pinned, with provenance) · aes_gcm.py
tests/                   72 stdlib tests + committed fixture repositories
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
