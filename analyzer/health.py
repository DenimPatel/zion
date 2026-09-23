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
- **Defect-prone**: an unusually high share of the file's commits read as
  fixes (`gitmeta.FIX_RE`). Top decile, at least five commits and two fixes,
  and only when the repo's commit subjects say "fix" often enough to mean it.
- **Trend**: the last quarter's commits against the quarter before; a
  hotspot that is *rising* is the refactor that gets more expensive by the
  week.
- **Hub**: top decile of both fan-in and fan-out -- a change there ripples
  up and down the import graph at once.
- **Import depth**: the longest chain of imports reachable from a file, with
  cycles collapsed to one step. Deep chains are where a leaf change travels.
- **Debt markers**: TODO/FIXME/HACK/XXX comments, counted per file.

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
MIN_HISTORY_COMMITS = 10
DEFECT_PERCENTILE = 0.9
DEFECT_MIN_COMMITS = 5
DEFECT_MIN_FIXES = 2
DEFECT_MIN_RATIO = 0.3
DEFECT_REPO_SHARE = 0.05  # at least 5% of all commits must read as fixes
TREND_MONTHS = 3  # a quarter, in gitmeta's 30-day buckets
TREND_MIN_SPAN_DAYS = 150.0
HUB_PERCENTILE = 0.9
HUB_MIN_DEGREE = 3

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


def strongly_connected(edges: dict[str, set[str]]) -> list[list[str]]:
    """Tarjan's algorithm, iterative so a deep import chain cannot hit the
    recursion limit. Returns only components with more than one member."""
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
                if len(members) > 1:
                    components.append(sorted(members))
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

    _finalize_defects(analysis, git, code)
    _finalize_trend(analysis, git, code)
    # Vendored code's TODOs are its upstream's, not this repository's.
    for record in files:
        if record.debt and is_vendored(record.rel):
            record.debt = []
    flags.debt = any(f.debt for f in code)

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
    analysis.cycles = strongly_connected(edges)
    for cycle_id, members in enumerate(analysis.cycles, start=1):
        for rel in members:
            record = by_rel.get(rel)
            if record is not None:
                record.cycle_id = cycle_id
                record.cycle_size = len(members)

    _finalize_hubs(analysis, code)
    _finalize_depth(analysis, edges, by_rel)


def _finalize_defects(analysis, git, code) -> None:
    """Defect-prone files: an unusually high share of fix commits."""
    flags = analysis.flags
    total = git.commit_count if git is not None and git.available else 0
    fixes = getattr(git, "fix_commits", 0) if git is not None else 0
    flags.defects = bool(total >= MIN_HISTORY_COMMITS and fixes >= 3 and fixes >= total * DEFECT_REPO_SHARE)
    if not flags.defects:
        if total >= MIN_HISTORY_COMMITS:
            flags.notes.append("Too few commit subjects read as fixes - defect-prone flags disabled.")
        return
    busy = [f for f in code if f.commits >= DEFECT_MIN_COMMITS and not is_vendored(f.rel)]
    ranks = _rank([(f.rel, f.fix_ratio) for f in busy])
    for record in busy:
        record.is_defect = (
            ranks.get(record.rel, 0.0) >= DEFECT_PERCENTILE
            and record.fix_commits >= DEFECT_MIN_FIXES
            and record.fix_ratio >= DEFECT_MIN_RATIO
        )
    flags.defects = any(f.is_defect for f in busy)


def _finalize_trend(analysis, git, code) -> None:
    """Rising, steady or cooling: the last quarter against the one before."""
    flags = analysis.flags
    available = git is not None and git.available
    span = (git.last_ts - git.first_ts) / 86400.0 if available else 0.0
    # Its own rule, not the crane's: a history of one-file commits still has
    # a shape over time.
    flags.trend = bool(available and git.commit_count >= MIN_HISTORY_COMMITS and span >= TREND_MIN_SPAN_DAYS)
    if not flags.trend:
        return
    for record in code:
        activity = record.activity or []
        recent = sum(activity[:TREND_MONTHS])
        before = sum(activity[TREND_MONTHS : TREND_MONTHS * 2])
        if recent >= 2 and recent >= before * 1.5 + 1:
            record.trend = 1
        elif before >= 2 and recent * 2 <= before:
            record.trend = -1
        record.is_rising_hotspot = record.is_hotspot and record.trend == 1


def _finalize_hubs(analysis, code) -> None:
    """Hubs: top decile of both fan-in and fan-out, past an absolute floor."""
    eligible = [f for f in code if not is_vendored(f.rel) and not f.is_test]
    fan_in = _rank([(f.rel, float(f.import_in_degree)) for f in eligible if f.import_in_degree > 0])
    fan_out = _rank([(f.rel, float(len(f.imports_resolved))) for f in eligible if f.imports_resolved])
    for record in eligible:
        record.is_hub = (
            record.import_in_degree >= HUB_MIN_DEGREE
            and len(record.imports_resolved) >= HUB_MIN_DEGREE
            and fan_in.get(record.rel, 0.0) >= HUB_PERCENTILE
            and fan_out.get(record.rel, 0.0) >= HUB_PERCENTILE
        )
    analysis.flags.hubs = any(f.is_hub for f in eligible)


def _finalize_depth(analysis, edges: dict[str, set[str]], by_rel: dict) -> None:
    """Longest import chain from every file, on the graph with cycles collapsed.

    Iterative, so a 50,000-file repository cannot hit the recursion limit.
    """
    component: dict[str, int] = {}
    for cycle_id, members in enumerate(analysis.cycles, start=1):
        for rel in members:
            component[rel] = -cycle_id
    nodes = set(edges) | {t for targets in edges.values() for t in targets}
    ids = {}
    for rel in sorted(nodes):
        key = component.get(rel)
        ids[rel] = key if key is not None else len(ids) + 1
    dag: dict[int, set[int]] = {}
    for source, targets in edges.items():
        a = ids[source]
        for target in targets:
            b = ids[target]
            if a != b:
                dag.setdefault(a, set()).add(b)
    depth: dict[int, int] = {}
    for start in dag:
        if start in depth:
            continue
        stack = [(start, iter(dag.get(start, ())))]
        on_path = {start}
        while stack:
            node, children = stack[-1]
            advanced = False
            for child in children:
                if child in depth or child in on_path:
                    continue
                stack.append((child, iter(dag.get(child, ()))))
                on_path.add(child)
                advanced = True
                break
            if advanced:
                continue
            stack.pop()
            on_path.discard(node)
            depth[node] = 1 + max((depth.get(c, 0) for c in dag.get(node, ())), default=-1)
    for rel, key in ids.items():
        record = by_rel.get(rel)
        if record is not None:
            record.import_depth = max(0, depth.get(key, 0))


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
        # The deeper layer.
        "defects": top(lambda f: f.is_defect, lambda f: (-f.fix_ratio, -f.fix_commits, f.rel)) if flags.defects else [],
        "rising": top(lambda f: f.is_rising_hotspot, lambda f: (f.hotspot_rank, f.rel)) if flags.trend else [],
        "hubs": top(lambda f: f.is_hub, lambda f: (-(f.import_in_degree + len(f.imports_resolved)), f.rel)),
        "debt": top(lambda f: bool(f.debt), lambda f: (-len(f.debt), f.rel)) if flags.debt else [],
        "clones": [[a, b] for a, b, _, _ in getattr(analysis, "clones", [])[:REVIEW_LIMIT]],
        "hiddenCoupling": [[a, b] for a, b, _ in getattr(analysis, "hidden_couplings", [])[:REVIEW_LIMIT]],
    }
