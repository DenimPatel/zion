# Vendored dependencies

## three.module.js

- Package: `three@0.160.0`
- Source: `npm pack three@0.160.0` → `package/build/three.module.js`
- SHA-256 (first 16): `76dea8151bc9352a`
- Retrieved: from the npm registry, which is reachable in this environment

Only this single file is vendored. There is no `package.json`, no
`node_modules`, and nothing to install.

### Why vendor rather than use a CDN

The viewer must work with no network at all: it is opened from a local server
started by `zion serve`, and the `--single-file` build is meant to be opened by
double-clicking a local file. A CDN import would make both depend on the
network. (As of this writing unpkg and jsdelivr do both respond 200, so this is
a deliberate offline-first choice rather than a workaround for a blocked proxy.)

### Why not Node-side tooling

Node 25 and npm 11 are present, and Node's AES-GCM is roughly 1,000x faster
than the pure-Python fallback. Using them at *build* time would break the
central promise of the analyzer -- `python3 zion.py build <repo>` with no
dependencies beyond the standard library -- so they are deliberately unused.

License: MIT, see `three.LICENSE.txt`.
