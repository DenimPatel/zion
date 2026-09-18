# Scale benchmark

Measured on this machine (macOS, Apple silicon). Everything here is reproducible
from the commands below; numbers are the deterministic gates the project commits
to, with frame timing explicitly marked as not trustworthy under headless
software rendering.

## Reference repositories

| Repository | Files | Districts (depth) | Logical lines | Build time | City size |
|---|---|---|---|---|---|
| `macro-harness` | 28 | 4 (depth 1) | 2,562 | 0.25 s | 1.5 MB |
| `interactive-courses` | 357 | 30 (depth 2) | 155,157 | 2.3 s | 12.3 MB |

Both builds include full source in the interiors, so the city is roughly the size
of the repository it describes. `interactive-courses` writes 11.3 MB of source
for an 11.8 MB repository.

## Synthetic 50k repository

```
python3 bench/generate_repo.py bench/tmp/repo-50000 --files 50000 --commits 40
python3 zion.py build bench/tmp/repo-50000 -o /tmp/zion50k
python3 -m http.server 8815 --directory /tmp/zion50k
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --virtual-time-budget=180000 --dump-dom "http://127.0.0.1:8815/?bench=1&shadows=0"
```

| Measurement | Value |
|---|---|
| Files generated | 50,013 across 2,000 directories |
| Git history | 40 commits, 3 authors, 12 active dates |
| Analysis time | 16.4 s |
| Build time (incl. emit) | 41.2 s |
| City size on disk | 62.6 MB (17.0 MB of source + 100,026 files under `f/`) |
| Districts | 320 at depth 2 |
| **Draw calls** | **18** |
| Triangles | 244,572 |
| Resident buildings | 19,880 (capped at 20,000) |
| Resident district chunks | 129 of 320 |

**Draw calls do not grow with building count.** The 28-file village renders in 10
draw calls and the 50,000-file city renders in 18, because one `InstancedMesh`
exists per (archetype × LOD tier), not per district or per building. The extra
calls at 50k are the L3 district impostors that fill the horizon where streaming
stops.

The working set is bounded by `maxResident`, and unloaded districts are drawn as
one impostor box each from the manifest's own skyline envelope -- so a 6.7 km
city keeps a bounded resident set without a hard edge at the horizon.

## Why frame times are not reported

`?bench=1` reports `timingMode: "virtual-time (frame times unavailable)"` and
`frameP50: null` when run under Chrome's `--virtual-time-budget`. That flag
freezes the clock during a synchronous render loop, so `performance.now()` deltas
come back as exactly 0 -- a number that would look excellent and mean nothing. The
benchmark refuses to publish it rather than quietly reporting a fiction.

Draw calls, triangle counts, resident buildings and resident chunk counts are
deterministic and are the gates above. For real frame timing, run the viewer in a
desktop browser and call `window.zion.runBench(300)`, which measures with a live
clock and prints the same payload with `timingMode: "real"`.

Note also that headless Chrome uses SwiftShader software rasterization, so even a
real clock there would not represent GPU performance.

## Reproducing the gates

- Draw calls ≤ 60: reported by `?bench=1`, asserted by the in-browser self-test.
- Resident buildings bounded: `residentBuildings` never exceeds `maxResident`.
- No unbounded growth over a camera sweep: the benchmark sweeps the camera
  through 1.6 radians and reports the resident set at the end.
- Beyond ~20,000 resident buildings, headless SwiftShader cannot complete a
  1280x800 frame in reasonable time; the `?maxres=` and `?shadows=0` parameters
  exist so the benchmark can shrink the working set without changing the code
  paths under test.
