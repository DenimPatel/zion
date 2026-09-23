"""Dependency structure between the parts of a repository.

`metrics._finalize_downtown` resolves every file's imports to other files, and
`health.py` looks for cycles in them. That answers "is this file tangled?". An
architect's next question is about the *parts*: which folder depends on which,
which boundaries are crossed against the grain, and how stable each folder is.

Everything here works on the leaf districts `layout.build_layout` assigns, so
it runs once the layout exists (it is called at the end of `build_layout`) and
is idempotent: a second layout pass recomputes it from scratch.

Signals, each relative to the repository itself:

- **Afferent / efferent coupling** per folder (Robert C. Martin's Ca and Ce):
  how many files outside import something inside, and how many files inside
  import something outside. **Instability** is ``Ce / (Ca + Ce)``: 0 is a
  foundation everything leans on, 1 is a leaf nothing depends on.
- **The dependency matrix**: file-level import edges summed per folder pair.
- **Layering violations**: an import that points the wrong way. With a rules
  file (``.zion/rules.json`` or ``zion.rules.json`` in the analyzed repo, read
  only) the rule is the file's; without one it is "against the majority
  direction between two folders" -- a folder pair that imports both ways is
  a folder-level cycle, and the thinner direction is the edge to break.
- **Cross-folder co-change**: co-change pairs whose ends live in different
  folders, summed per folder pair. Hidden coupling, at the scale of parts.

The rules file format::

    {
      "layers": ["web", "app", ["domain", "model"], "infra"],
      "forbid": [["domain", "web"], {"from": "lib/**", "to": "app/**"}]
    }

``layers`` is ordered top to bottom: a file may import its own layer or any
layer below it, never one above. Each entry is a path prefix, a glob, or a list
of them. ``forbid`` lists (from, to) pairs that must never be imported, in
either list or object form.
"""

from __future__ import annotations

import fnmatch
import json
import os
from dataclasses import dataclass, field

from .health import is_vendored

RULES_FILES = (".zion/rules.json", "zion.rules.json")
# The co-change between folders that is worth naming: the strongest few pairs.
MAX_DISTRICT_COUPLING = 12


@dataclass
class DistrictDeps:
    ca: int = 0  # files outside that import something here
    ce: int = 0  # files here that import something outside
    instability: float | None = None
    edges_in: int = 0
    edges_out: int = 0
    violations: int = 0  # violating edges that start here


@dataclass
class Architecture:
    rules: str = ""  # "" (no imports), "majority", or the rules file's path
    rules_error: str = ""
    matrix: dict[tuple[str, str], int] = field(default_factory=dict)
    districts: dict[str, DistrictDeps] = field(default_factory=dict)
    # (importer rel, imported rel, the rule it breaks)
    violations: list[tuple[str, str, str]] = field(default_factory=list)
    # (district a, district b, co-changed file pairs, commits between them)
    coupling: list[tuple[str, str, int, int]] = field(default_factory=list)


def _matches(rel: str, pattern: str) -> bool:
    pattern = pattern.strip().strip("/")
    if not pattern:
        return False
    if any(ch in pattern for ch in "*?["):
        if fnmatch.fnmatch(rel, pattern):
            return True
        # `src/**` should also match `src` itself as a folder prefix.
        return pattern.endswith("/**") and (rel + "/").startswith(pattern[:-2])
    return rel == pattern or rel.startswith(pattern + "/")


def _patterns(entry) -> list[str]:
    if isinstance(entry, str):
        return [entry]
    if isinstance(entry, (list, tuple)):
        return [str(p) for p in entry if isinstance(p, str)]
    return []


def load_rules(root: str) -> tuple[dict | None, str, str]:
    """(rules, path, error). Read-only: the analyzed repository is never written."""
    for rel in RULES_FILES:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as error:
            return None, rel, f"{rel} could not be read: {error}"
        if not isinstance(data, dict):
            return None, rel, f"{rel} must hold a JSON object"
        return data, rel, ""
    return None, "", ""


class _RuleSet:
    def __init__(self, data: dict) -> None:
        self.layers = [_patterns(entry) for entry in data.get("layers") or []]
        self.forbid: list[tuple[list[str], list[str]]] = []
        for entry in data.get("forbid") or []:
            if isinstance(entry, dict):
                self.forbid.append((_patterns(entry.get("from")), _patterns(entry.get("to"))))
            elif isinstance(entry, (list, tuple)) and len(entry) == 2:
                self.forbid.append((_patterns(entry[0]), _patterns(entry[1])))

    def layer_of(self, rel: str) -> int | None:
        for index, patterns in enumerate(self.layers):
            if any(_matches(rel, p) for p in patterns):
                return index
        return None

    def check(self, src: str, dst: str) -> str:
        for sources, targets in self.forbid:
            if any(_matches(src, p) for p in sources) and any(_matches(dst, p) for p in targets):
                return f"forbidden: {'/'.join(sources)} must not import {'/'.join(targets)}"
        a, b = self.layer_of(src), self.layer_of(dst)
        if a is not None and b is not None and b < a:
            return f"layer {a + 1} imports layer {b + 1}, which sits above it"
        return ""


def _eligible(record) -> bool:
    """Files whose imports say something about the design: no tests, no vendored code."""
    return not record.is_test and not is_vendored(record.rel)


def finalize_architecture(analysis, root: str | None = None) -> Architecture:
    """Fill `analysis.architecture` and each file's violation fields."""
    arch = Architecture()
    files = analysis.files
    by_rel = {f.rel: f for f in files}
    for record in files:
        record.import_violations = []
        record.is_violation = False
        out = len(record.imports_resolved)
        total = out + record.import_in_degree
        record.file_instability = round(out / total, 4) if total else -1.0

    if not analysis.flags.imports:
        analysis.architecture = arch
        analysis.flags.layering = False
        return arch

    edges: list[tuple[str, str]] = []
    for record in files:
        if not _eligible(record):
            continue
        for target in record.imports_resolved:
            other = by_rel.get(target)
            if other is None or not _eligible(other) or target.endswith("/__init__.py"):
                continue
            edges.append((record.rel, target))

    # -- per-folder coupling ------------------------------------------------
    importers_in: dict[str, set[str]] = {}
    importers_out: dict[str, set[str]] = {}
    for src, dst in edges:
        d_src, d_dst = by_rel[src].district, by_rel[dst].district
        if d_src == d_dst:
            continue
        arch.matrix[(d_src, d_dst)] = arch.matrix.get((d_src, d_dst), 0) + 1
        importers_in.setdefault(d_dst, set()).add(src)
        importers_out.setdefault(d_src, set()).add(src)
    for key in {f.district for f in files}:
        deps = DistrictDeps(ca=len(importers_in.get(key, ())), ce=len(importers_out.get(key, ())))
        total = deps.ca + deps.ce
        deps.instability = round(deps.ce / total, 4) if total else None
        arch.districts[key] = deps
    for (d_src, d_dst), count in arch.matrix.items():
        arch.districts[d_src].edges_out += count
        arch.districts[d_dst].edges_in += count

    # -- violations -----------------------------------------------------------
    rules_data, rules_path, error = load_rules(root or analysis.root)
    arch.rules_error = error
    if rules_data is not None:
        arch.rules = rules_path
        ruleset = _RuleSet(rules_data)
        for src, dst in edges:
            reason = ruleset.check(src, dst)
            if reason:
                arch.violations.append((src, dst, reason))
    else:
        arch.rules = "majority"
        for src, dst in edges:
            d_src, d_dst = by_rel[src].district, by_rel[dst].district
            if d_src == d_dst:
                continue
            forward = arch.matrix.get((d_src, d_dst), 0)
            backward = arch.matrix.get((d_dst, d_src), 0)
            # Only a folder pair that imports both ways has a wrong way. The
            # thinner direction is the one to cut; a tie is a tangle, and both
            # directions are reported.
            if backward and forward <= backward:
                arch.violations.append(
                    (src, dst, f"{forward} import(s) this way against {backward} the other way: a folder-level cycle")
                )

    for src, dst, _reason in arch.violations:
        record = by_rel[src]
        record.import_violations.append(dst)
        record.is_violation = True
        deps = arch.districts.get(record.district)
        if deps is not None:
            deps.violations += 1
    analysis.flags.layering = bool(arch.violations)

    # -- co-change across folders --------------------------------------------
    git = analysis.git
    if analysis.flags.coupling and git is not None:
        pairs: dict[tuple[str, str], list[int]] = {}
        for (path_a, path_b), count in git.coupling.items():
            a, b = by_rel.get(path_a), by_rel.get(path_b)
            if a is None or b is None or a.district == b.district:
                continue
            key = tuple(sorted((a.district, b.district)))
            bucket = pairs.setdefault(key, [0, 0])
            bucket[0] += 1
            bucket[1] += count
        ranked = sorted(pairs.items(), key=lambda kv: (-kv[1][1], -kv[1][0], kv[0]))
        arch.coupling = [(a, b, n, c) for (a, b), (n, c) in ranked[:MAX_DISTRICT_COUPLING]]

    analysis.architecture = arch
    return arch
