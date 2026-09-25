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
- **Hidden coupling**, file by file: two files in different folders that keep
  changing together although neither imports the other. The dependency is
  real -- a shared format, a protocol, a copy -- but the code does not say so.
- **Coordination cost** (Conway): per folder, how many people worked in it
  over the last three months, how much of its work also had to touch another
  folder in the same commit, and whether anyone leads it. Many recent authors
  and no expert above 40% is "many cooks": the folder has no owner in practice.
- **Abstractness and distance from the main sequence** (Martin's A and D):
  ``A`` is the share of a folder's type definitions that are abstract, and
  ``D = |A + I - 1|``. A stable, concrete folder (low A, low I) is the "zone
  of pain": everything leans on it and nothing in it bends. An abstract folder
  nothing depends on (high A, high I) is the "zone of uselessness".

- **Abstractness and the main sequence**: the share of a folder's classes that
  are abstract (ABCs, Protocols, interfaces, traits). With instability it
  places the folder against Martin's main sequence ``A + I = 1``; the distance
  ``D = |A + I - 1|`` is small for a healthy folder. Far off it, a concrete
  folder everything leans on is in the *zone of pain* (hard to change, and
  every change ripples), an abstract folder nothing uses in the *zone of
  uselessness*.
- **Building codes**: declared limits per file (size, fan-out, fan-in, the
  branchiest function, floors, debt markers), read from the same rules file.
  They need no import data and are checked whether or not imports resolved.

The rules file format::

    {
      "layers": ["web", "app", ["domain", "model"], "infra"],
      "forbid": [["domain", "web"], {"from": "lib/**", "to": "app/**"}],
      "codes": {"max_loc": 800, "max_fanout": 20}
    }

``codes`` is either one object (the whole repository) or a list of them, each
with an optional ``paths`` (a pattern or list of patterns); a later entry that
matches a file overrides an earlier one, limit by limit.

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
# Main sequence: how far off A + I = 1 a folder must sit to be in a zone, and
# how much there must be to judge -- two classes and three coupled files.
ZONE_DISTANCE = 0.5
ZONE_MIN_CLASSES = 2
ZONE_MIN_COUPLING = 3
# Building codes: limit name -> (what it measures, how the report words it).
CODE_LIMITS = {
    "max_loc": (lambda f: f.logical_loc, "logical lines"),
    "max_fanout": (lambda f: len(f.imports_resolved), "files imported"),
    "max_fanin": (lambda f: f.import_in_degree, "importers"),
    "max_cx": (lambda f: f.brace_complexity or f.max_complexity, "decision points in one definition"),
    "max_floors": (lambda f: len(f.floors), "floors"),
    "max_debt": (lambda f: f.debt_markers, "debt markers"),
}
# File pairs: at least this many shared commits, and together in at least half
# of the quieter file's commits, so two busy files are not paired by chance.
HIDDEN_MIN_COMMITS = 3
HIDDEN_MIN_SHARE = 0.5
MAX_HIDDEN_PAIRS = 200
MAX_HIDDEN_PER_FILE = 8
# A folder needs a few recent authors working across folders to say its
# coordination cost is real.
RECENT_MONTHS = 3
MANY_COOKS_AUTHORS = 5
MANY_COOKS_TOP_SHARE = 0.4


@dataclass
class DistrictDeps:
    ca: int = 0  # files outside that import something here
    ce: int = 0  # files here that import something outside
    instability: float | None = None
    edges_in: int = 0
    edges_out: int = 0
    violations: int = 0  # violating edges that start here
    classes: int = 0
    abstract: int = 0
    abstractness: float | None = None  # A: abstract / all type definitions
    distance: float | None = None  # D = |A + I - 1|, distance from the main sequence
    zone: str = ""  # "" | "pain" | "uselessness"
    # Coordination cost (Conway): who works here, and how much of the work
    # here also has to touch another folder in the same commit.
    recent_authors: int = 0  # distinct authors in the last three months
    commits: int = 0  # commits touching this folder
    cross_share: float = 0.0  # of those, the share that also touched another folder
    top_share: float = 0.0  # the leading expert's share of recency-weighted authorship
    many_cooks: bool = False


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
    codes_declared: bool = False
    code_violations: int = 0


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


def _code_entries(data: dict | None) -> list[tuple[list[str], dict[str, float]]]:
    """(patterns, limits) per `codes` entry; no patterns means every file."""
    if not data:
        return []
    raw = data.get("codes")
    entries = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    out = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        limits = {
            key: float(value)
            for key, value in entry.items()
            if key in CODE_LIMITS and isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
        }
        if limits:
            out.append((_patterns(entry.get("paths")), limits))
    return out


def _apply_codes(analysis, arch: Architecture, rules_data: dict | None) -> None:
    """Mark every file that breaks a declared building code."""
    entries = _code_entries(rules_data)
    arch.codes_declared = bool(entries)
    count = 0
    for record in analysis.files:
        record.code_violations = []
        if not entries or record.is_binary or record.rows is not None or record.is_doc or record.is_ruin:
            continue
        if not _eligible(record):
            continue
        limits: dict[str, float] = {}
        for patterns, entry_limits in entries:
            if not patterns or any(_matches(record.rel, p) for p in patterns):
                limits.update(entry_limits)
        for key, limit in sorted(limits.items()):
            measure, words = CODE_LIMITS[key]
            value = measure(record)
            if value > limit:
                record.code_violations.append(f"{key}: {value:g} {words} > {limit:g}")
        count += bool(record.code_violations)
    arch.code_violations = count
    analysis.flags.codes = count > 0
    # The layout can run this twice; a note is stated once.
    note = (
        "No building codes declared in .zion/rules.json - code notices disabled."
        if not entries
        else "" if count else "Every file meets the declared building codes."
    )
    if note and note not in analysis.flags.notes:
        analysis.flags.notes.append(note)


def _main_sequence(files, arch: Architecture) -> None:
    """Abstractness per folder and its distance from A + I = 1."""
    for record in files:
        if not _eligible(record) or not record.class_count:
            continue
        deps = arch.districts.get(record.district)
        if deps is not None:
            deps.classes += record.class_count
            deps.abstract += min(record.abstract_count, record.class_count)
    for deps in arch.districts.values():
        if deps.classes:
            deps.abstractness = round(deps.abstract / deps.classes, 4)
        if deps.abstractness is None or deps.instability is None:
            continue
        deps.distance = round(abs(deps.abstractness + deps.instability - 1.0), 4)
        if deps.distance < ZONE_DISTANCE or deps.classes < ZONE_MIN_CLASSES or deps.ca + deps.ce < ZONE_MIN_COUPLING:
            continue
        deps.zone = "pain" if deps.abstractness + deps.instability < 1.0 else "uselessness"


def _eligible(record) -> bool:
    """Files whose imports say something about the design: no tests, no vendored code."""
    return not record.is_test and not is_vendored(record.rel)


def finalize_architecture(analysis, root: str | None = None) -> Architecture:
    """Fill `analysis.architecture` and each file's violation fields."""
    arch = Architecture()
    files = analysis.files
    by_rel = {f.rel: f for f in files}
    analysis.hidden_couplings = []
    analysis.flags.hidden_coupling = False
    analysis.flags.abstractness = False
    for record in files:
        record.import_violations = []
        record.is_violation = False
        record.hidden_coupling = []
        record.is_hidden_coupling = False
        out = len(record.imports_resolved)
        total = out + record.import_in_degree
        record.file_instability = round(out / total, 4) if total else -1.0

    rules_data, rules_path, error = load_rules(root or analysis.root)
    arch.rules_error = error
    _apply_codes(analysis, arch, rules_data)
    _teams(analysis, arch)

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
        deps = arch.districts.setdefault(key, DistrictDeps())
        deps.ca = len(importers_in.get(key, ()))
        deps.ce = len(importers_out.get(key, ()))
        total = deps.ca + deps.ce
        deps.instability = round(deps.ce / total, 4) if total else None
    for (d_src, d_dst), count in arch.matrix.items():
        arch.districts[d_src].edges_out += count
        arch.districts[d_dst].edges_in += count
    _main_sequence(files, arch)
    analysis.flags.abstractness = any(d.distance is not None for d in arch.districts.values())

    # -- violations -----------------------------------------------------------
    # A rules file that only declares building codes says nothing about the
    # layering, so the majority rule still applies.
    if rules_data is not None and (rules_data.get("layers") or rules_data.get("forbid")):
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
        _hidden_coupling(analysis, by_rel)

    analysis.architecture = arch
    return arch


def _hidden_coupling(analysis, by_rel: dict) -> None:
    """Co-change without an import either way, across folders."""
    git = analysis.git
    for record in analysis.files:
        record.hidden_coupling = []
        record.is_hidden_coupling = False
    resolved = {f.language for f in analysis.files if f.import_in_degree > 0}
    found: list[tuple[str, str, int]] = []
    for (path_a, path_b), count in git.coupling.items():
        if count < HIDDEN_MIN_COMMITS:
            continue
        a, b = by_rel.get(path_a), by_rel.get(path_b)
        if a is None or b is None or a.district == b.district:
            continue
        if not (_eligible(a) and _eligible(b)) or a.is_doc or b.is_doc or a.is_binary or b.is_binary:
            continue
        # Only where imports can be seen at all: otherwise every pair would be
        # "hidden" simply because this language's imports never resolve.
        if a.language not in resolved or b.language not in resolved:
            continue
        if path_b in a.imports_resolved or path_a in b.imports_resolved:
            continue
        quieter = max(1, min(a.commits, b.commits))
        if count / quieter < HIDDEN_MIN_SHARE:
            continue
        found.append((path_a, path_b, count))
    found.sort(key=lambda p: (-p[2], p[0], p[1]))
    found = found[:MAX_HIDDEN_PAIRS]
    for path_a, path_b, count in found:
        for this, other in ((path_a, path_b), (path_b, path_a)):
            record = by_rel[this]
            record.is_hidden_coupling = True
            if len(record.hidden_coupling) < MAX_HIDDEN_PER_FILE:
                record.hidden_coupling.append((other, count))
    analysis.hidden_couplings = found
    analysis.flags.hidden_coupling = bool(found)


def _teams(analysis, arch: Architecture) -> None:
    """Per-folder coordination cost, from the commit hashes gitmeta kept."""
    git = analysis.git
    flags = analysis.flags
    flags.teams = False
    if not flags.authorship or git is None or not git.available:
        return
    districts_of_commit: dict[str, set[str]] = {}
    members: dict[str, list] = {}
    for record in analysis.files:
        members.setdefault(record.district, []).append(record)
        file_git = git.files.get(record.rel)
        if file_git is None:
            continue
        for commit in file_git.hashes:
            districts_of_commit.setdefault(commit, set()).add(record.district)
    for key, records in members.items():
        deps = arch.districts.setdefault(key, DistrictDeps())
        recent = set()
        scores: dict[str, float] = {}
        commits: set[str] = set()
        for record in records:
            for author, buckets in record.author_buckets.items():
                if any(b < RECENT_MONTHS for b in buckets):
                    recent.add(author)
            for author, score in record.expert_scores.items():
                scores[author] = scores.get(author, 0.0) + score
            file_git = git.files.get(record.rel)
            if file_git is not None:
                commits.update(file_git.hashes)
        deps.recent_authors = len(recent)
        deps.commits = len(commits)
        crossing = sum(1 for c in commits if len(districts_of_commit.get(c, ())) > 1)
        deps.cross_share = round(crossing / len(commits), 4) if commits else 0.0
        total = sum(scores.values())
        deps.top_share = round(max(scores.values()) / total, 4) if total else 0.0
        deps.many_cooks = deps.recent_authors > MANY_COOKS_AUTHORS and deps.top_share < MANY_COOKS_TOP_SHARE
        if deps.recent_authors:
            flags.teams = True
