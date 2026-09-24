"""Architect's signals: where a repository would most repay attention.

Everything here is derived from numbers `metrics.py` already measured -- no
file is re-read and no extra git call is made. Each signal is relative to
*this* repository (a percentile, not a fixed cut-off) wherever a fixed number
would mean something different in a 50-file repo and a 50,000-file one, and
each is gated on the same degeneration flag as the data it stands on:

- **Hotspot**: changed often *and* large. Change frequency times size is the
  classic place where refactoring pays back soonest; either alone is not a
  smell (a big stable file is fine, a small busy one is cheap to change).
- **Knowledge risk**: one author wrote at least half the file and has not
  committed anywhere in the repo for a long while -- the tenant moved out.
- **Oversized**: in the top 5% by logical lines *and* past an absolute floor,
  so a repo of ten-line files does not call its biggest one oversized.
- **Orphan candidate**: nothing in the repo imports it, it is not an entry
  point, and it has sat untouched for months. Import resolution is
  best-effort (Python `ast`, relative JS/TS paths), so this is a question to
  ask, never a verdict -- and it is only raised for languages where at least
  one import in this repo *did* resolve.
- **Import cycle**: strongly connected components of the resolved import
  graph with more than one member.
- **Blast radius** (impact): how many files transitively import this one --
  everything a change here can reach. Tests and vendored code are not counted
  as dependents. Exact, and near-linear: one pass over the import graph's
  strongly connected components, carrying each one's dependents as an integer
  bitset that is dropped as soon as the last component that needs it is done.
- **Bug-prone**: the files whose commits most often say they fix something
  (fix, bug, hotfix, regression in the subject). Churn says a file changes;
  this says it keeps *breaking*. Top 5% by fix commits, with at least two of
  them and a quarter of the file's commits.
- **Debt markers**: TODO / FIXME / HACK / XXX written in comments.

Vendored third-party code (`vendor/`, `third_party/`, `*.min.js`, ...) is left
out of every signal: it is not this repository's to split or own.

All times are measured back from the repository's newest commit, never the
wall clock, so a build is reproducible and an old clone reads as it was.
"""

from __future__ import annotations

HOTSPOT_FRACTION = 0.05
OVERSIZED_PERCENTILE = 0.95
OVERSIZED_MIN_LOC = 400
STALE_DAYS = 180.0
OWNER_AWAY_DAYS = 180.0
REVIEW_LIMIT = 15
# int.bit_count is Python 3.10+; the fallback is only ever slower, never wrong.
_popcount = int.bit_count if hasattr(int, "bit_count") else (lambda value: bin(value).count("1"))
BUGPRONE_FRACTION = 0.05
BUGPRONE_MIN_FIXES = 2
BUGPRONE_MIN_RATIO = 0.25

# Third-party code copied into the tree: not this repository's to refactor, so
# it is never a hotspot, oversized, an orphan or a knowledge risk.
VENDOR_DIRS = {"vendor", "vendors", "third_party", "thirdparty", "third-party", "external", "extern", "node_modules"}
VENDOR_SUFFIXES = (".min.js", ".min.css", "-min.js", ".bundle.js")


def is_vendored(rel: str) -> bool:
    parts = rel.lower().split("/")
    return any(part in VENDOR_DIRS for part in parts[:-1]) or parts[-1].endswith(VENDOR_SUFFIXES)


# Languages whose imports `metrics._finalize_downtown` can resolve at all.
IMPORT_LANGUAGES = ("python", "javascript", "typescript")
# Files that are reached by convention, not by import.
CONVENTIONAL_ENTRY_NAMES = {
    "__init__.py", "__main__.py", "setup.py", "conftest.py", "manage.py", "wsgi.py", "asgi.py",
    "index.js", "index.ts", "index.jsx", "index.tsx", "main.js", "main.ts",
}


def _is_code(record) -> bool:
    return not (
        record.is_binary or record.rows is not None or record.is_doc or record.is_ruin or is_vendored(record.rel)
    )


def _rank(values: list[tuple[str, float]]) -> dict[str, float]:
    """Percentile rank 0..1 of positive values; ties share the higher rank."""
    positive = sorted((v, k) for k, v in values if v > 0)
    total = len(positive)
    ranks: dict[str, float] = {}
    i = 0
    while i < total:
        j = i
        while j + 1 < total and positive[j + 1][0] == positive[i][0]:
            j += 1
        for _, key in positive[i : j + 1]:
            ranks[key] = (j + 1) / total
        i = j + 1
    return ranks


def bus_factor(authors: dict[str, int]) -> int:
    """Fewest authors whose added lines reach half the file's added lines."""
    total = sum(v for v in authors.values() if v > 0)
    if total <= 0:
        return len(authors) and 1
    running = 0
    for count, value in enumerate(sorted((v for v in authors.values() if v > 0), reverse=True), start=1):
        running += value
        if running * 2 >= total:
            return count
    return len(authors)


def strongly_connected(edges: dict[str, set[str]], all_components: bool = False) -> list[list[str]]:
    """Tarjan's algorithm, iterative so a deep import chain cannot hit the
    recursion limit. Returns only components with more than one member,
    largest first -- or, with ``all_components``, every component in the
    order Tarjan finishes them: a component always after every component it
    has an edge to."""
    index_of: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    components: list[list[str]] = []
    counter = 0

    nodes = sorted(set(edges) | {t for targets in edges.values() for t in targets})
    for start in nodes:
        if start in index_of:
            continue
        work = [(start, iter(sorted(edges.get(start, ()))))]
        index_of[start] = low[start] = counter
        counter += 1
        stack.append(start)
        on_stack.add(start)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index_of:
                    index_of[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(sorted(edges.get(child, ())))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index_of[child])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index_of[node]:
                members = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    members.append(member)
                    if member == node:
                        break
                if all_components or len(members) > 1:
                    components.append(sorted(members))
    if not all_components:
        components.sort(key=lambda c: (-len(c), c[0]))
    return components


def finalize_health(analysis, git) -> None:
    """Fill every file's architect signals and the matching repo flags."""
    files = analysis.files
    flags = analysis.flags
    head = git.last_ts if git is not None and git.available else 0.0

    # -- people -------------------------------------------------------------
    for record in files:
        record.author_count = len(record.authors)
        record.bus_factor = bus_factor(record.authors) if record.authors else 0
        if flags.authorship and head and record.primary_author:
            owner_last = git.author_last_ts.get(record.primary_author, 0.0)
            record.owner_away_days = max(0.0, (head - owner_last) / 86400.0) if owner_last else 0.0
            record.owner_inactive = record.owner_away_days >= OWNER_AWAY_DAYS
            record.knowledge_risk = (
                record.owner_inactive and record.ownership_share >= 0.5 and record.commits >= 1 and _is_code(record)
            )
    flags.knowledge = flags.authorship and any(f.knowledge_risk for f in files)
    if flags.authorship and not flags.knowledge:
        flags.notes.append("Every main owner has committed within the last six months - no knowledge-risk flags.")

    # -- size ---------------------------------------------------------------
    code = [f for f in files if _is_code(f)]
    size_ranks = _rank([(f.rel, float(f.logical_loc)) for f in code])
    for record in files:
        record.size_pct = size_ranks.get(record.rel, 0.0)
        record.is_oversized = (
            _is_code(record) and record.size_pct >= OVERSIZED_PERCENTILE and record.logical_loc >= OVERSIZED_MIN_LOC
        )
        definitions = [fl for fl in record.floors if fl.kind in ("function", "method")] or [
            fl for fl in record.floors if fl.kind not in ("heading", "cell", "section")
        ]
        if definitions:
            longest = max(definitions, key=lambda fl: (fl.loc, -fl.line))
            record.longest_floor = (longest.name, int(longest.loc))
        record.max_complexity = max((int(fl.complexity) for fl in record.floors), default=0)

    # -- hotspots -----------------------------------------------------------
    if flags.churn:
        commit_ranks = _rank([(f.rel, float(f.commits)) for f in code])
        scored = []
        for record in code:
            score = commit_ranks.get(record.rel, 0.0) * size_ranks.get(record.rel, 0.0)
            record.hotspot = round(score, 4)
            if score > 0:
                scored.append(record)
        scored.sort(key=lambda f: (-f.hotspot, -f.commits, f.rel))
        cutoff = max(1, round(len(code) * HOTSPOT_FRACTION))
        for rank, record in enumerate(scored, start=1):
            record.hotspot_rank = rank
            record.is_hotspot = rank <= cutoff
    flags.hotspots = flags.churn and any(f.is_hotspot for f in files)

    # -- defects and debt ------------------------------------------------------
    _finalize_defects(analysis, git, code)
    flags.debt = any(f.debt_markers for f in code)
    if not flags.debt:
        flags.notes.append("No TODO / FIXME / HACK / XXX markers in code comments - debt potholes disabled.")

    # -- imports: orphans and cycles -----------------------------------------
    flags.imports = any(f.imports_resolved for f in files)
    # A submodule importing its own package's __init__ (to reach a re-export)
    # while the __init__ imports the submodule is how Python packages are
    # built, not a design smell -- those edges are left out of cycle search.
    edges: dict[str, set[str]] = {}
    for record in files:
        targets = {t for t in record.imports_resolved if not t.endswith("/__init__.py")}
        if targets:
            edges[record.rel] = targets
    if not flags.imports:
        flags.notes.append("No imports resolved - orphan and import-cycle checks disabled.")
        return

    resolved_languages = {f.language for f in files if f.import_in_degree > 0}
    for record in files:
        if record.language not in IMPORT_LANGUAGES or record.language not in resolved_languages:
            continue
        if not _is_code(record) or record.is_test or record.is_config:
            continue
        if record.import_in_degree > 0 or record.name in CONVENTIONAL_ENTRY_NAMES:
            continue
        if any(fl.is_entrypoint for fl in record.floors):
            continue
        idle = max(0.0, (head - record.last_ts) / 86400.0) if (head and record.last_ts) else None
        if idle is None or idle < STALE_DAYS:
            continue
        record.is_orphan = True

    by_rel = {f.rel: f for f in files}
    _finalize_impact(files, by_rel)
    analysis.cycles = strongly_connected(edges)
    for cycle_id, members in enumerate(analysis.cycles, start=1):
        for rel in members:
            record = by_rel.get(rel)
            if record is not None:
                record.cycle_id = cycle_id
                record.cycle_size = len(members)


def _finalize_defects(analysis, git, code) -> None:
    """Bug-prone files: the top slice by commits whose subject names a repair."""
    flags = analysis.flags
    total_fixes = git.fix_commits if git is not None and git.available else 0
    flags.defects = flags.churn and total_fixes >= 1
    if not flags.defects:
        flags.notes.append(
            "No commit subject names a fix (fix, bug, hotfix, regression) - bug-prone smoke disabled."
            if flags.churn
            else "Too little history to tell repairs from features - bug-prone smoke disabled."
        )
        return
    for record in code:
        record.fix_ratio = round(record.fix_commits / record.commits, 4) if record.commits else 0.0
    ranked = sorted(
        (f for f in code if f.fix_commits >= BUGPRONE_MIN_FIXES and f.fix_ratio >= BUGPRONE_MIN_RATIO),
        key=lambda f: (-f.fix_commits, -f.fix_ratio, f.rel),
    )
    cutoff = max(1, round(len(code) * BUGPRONE_FRACTION))
    for record in ranked[:cutoff]:
        record.is_bugprone = True


def _is_dependent(record) -> bool:
    """A file whose import counts toward another's blast radius."""
    return not (record.is_test or is_vendored(record.rel))


def _finalize_impact(files, by_rel) -> None:
    """Every file's transitive importers (``impact``) and their folders.

    Imports run importer -> imported, and a file's dependents are its
    importers plus theirs. Tarjan finishes a component after everything it
    imports, so walking its output backwards visits every importer before
    what it imports; each component's dependents are then the union of its
    importers' components and their dependents. Files and folders are bits
    in two Python ints, so a union is one C-level OR, and a component's
    bitset is released once every component it feeds has been computed.
    """
    imports: dict[str, set[str]] = {}
    for record in files:
        if not _is_dependent(record):
            continue
        targets = {t for t in record.imports_resolved if t != record.rel and t in by_rel}
        if targets:
            imports[record.rel] = targets
    if not imports:
        return
    components = strongly_connected(imports, all_components=True)
    comp_of: dict[str, int] = {}
    for index, members in enumerate(components):
        for rel in members:
            comp_of[rel] = index
    file_bit = {rel: 1 << i for i, rel in enumerate(sorted(comp_of))}
    folder_index: dict[str, int] = {}
    folder_bit: dict[str, int] = {}
    for rel in comp_of:
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        folder_bit[rel] = 1 << folder_index.setdefault(folder, len(folder_index))

    # Condensation: which components import which, and how many consumers
    # each component's bitset has left.
    feeds: list[set[int]] = [set() for _ in components]
    for src, targets in imports.items():
        a = comp_of[src]
        for dst in targets:
            b = comp_of[dst]
            if a != b:
                feeds[a].add(b)
    importers_of: list[set[int]] = [set() for _ in components]
    for a, targets in enumerate(feeds):
        for b in targets:
            importers_of[b].add(a)
    pending = [len(targets) for targets in feeds]
    files_of: dict[int, int] = {}
    folders_of: dict[int, int] = {}
    for index in range(len(components) - 1, -1, -1):
        members = components[index]
        # Upstream components never contain this one's members (that would
        # make them one component), so this is exactly "outside dependents".
        outside_files = 0
        outside_folders = 0
        for source in importers_of[index]:
            outside_files |= files_of[source]
            outside_folders |= folders_of[source]
            pending[source] -= 1
            if pending[source] == 0:
                del files_of[source], folders_of[source]
        for rel in members:
            reach_files = outside_files
            reach_folders = outside_folders
            if len(members) > 1:  # a cycle: every member reaches every other
                for other in members:
                    if other != rel:
                        reach_files |= file_bit[other]
                        reach_folders |= folder_bit[other]
            record = by_rel.get(rel)
            if record is not None:
                record.impact = _popcount(reach_files)
                record.impact_folders = _popcount(reach_folders)
        if pending[index]:
            files_of[index] = outside_files
            folders_of[index] = outside_folders
            for rel in members:
                files_of[index] |= file_bit[rel]
                folders_of[index] |= folder_bit[rel]


def review(analysis) -> dict:
    """The ranked lists City Hall's Architect's review shows, as file paths."""
    files = analysis.files
    flags = analysis.flags

    def top(pred, key, limit=REVIEW_LIMIT):
        return [f.rel for f in sorted((f for f in files if pred(f)), key=key)[:limit]]

    return {
        "hotspots": top(lambda f: f.is_hotspot, lambda f: f.hotspot_rank) if flags.hotspots else [],
        "oversized": top(lambda f: f.is_oversized, lambda f: (-f.logical_loc, f.rel)),
        "knowledge": top(lambda f: f.knowledge_risk, lambda f: (-f.logical_loc, f.rel)) if flags.knowledge else [],
        "orphans": top(lambda f: f.is_orphan, lambda f: (-f.logical_loc, f.rel)) if flags.imports else [],
        "cycles": [list(c) for c in analysis.cycles[:REVIEW_LIMIT]],
        # The next layer: architecture.py, testmap.py and owners.py.
        "violations": top(lambda f: f.is_violation, lambda f: (-len(f.import_violations), f.rel)),
        "untested": top(lambda f: f.untested_risk, lambda f: (f.hotspot_rank or 10**9, -f.logical_loc, f.rel)),
        "drift": top(lambda f: f.owner_drift, lambda f: (-f.logical_loc, f.rel)),
        "complexity": top(lambda f: f.is_braced, lambda f: (-f.brace_complexity, f.rel)),
        # Third layer: impact, defects, debt, building codes.
        "impact": top(lambda f: f.impact > 0 and _is_code(f), lambda f: (-f.impact, f.rel)) if flags.imports else [],
        "bugprone": top(lambda f: f.is_bugprone, lambda f: (-f.fix_commits, -f.fix_ratio, f.rel)),
        "debt": top(lambda f: f.debt_markers > 0 and _is_code(f), lambda f: (-f.debt_markers, f.rel)),
        "codes": top(lambda f: bool(f.code_violations), lambda f: (-len(f.code_violations), -f.logical_loc, f.rel)),
    }
