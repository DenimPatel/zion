"""The architect's report: the city's findings as Markdown or JSON, and a CI gate.

``python3 zion.py report <repo>`` prints what the City Guide's Health tab and
the inspectors show, as text a pull request, a wiki page or a CI log can
carry. ``--fail-on`` turns it into a gate: the command exits 1 when a named
condition holds, so a pipeline can refuse a change that adds an import cycle
or a layering violation.

Gate conditions (comma-separated):

- ``<signal>``: any file carries it now -- ``cycles``, ``violations``,
  ``hotspots``, ``oversized``, ``orphans``, ``knowledge``, ``untested``,
  ``drift``, ``bugprone``, ``defects``, ``rising-hotspots``, ``hubs``,
  ``clones``, ``hidden-coupling``, ``debt``, ``codes`` (a declared building
  code is broken), ``zone-of-pain`` (a folder sits there or in it),
  ``undeclared-dep`` (a third-party package is imported but no manifest
  declares it);
- ``budgets``: a file is over a numeric budget from the rules file
  (``.zion/rules.json`` / ``zion.rules.json``, read only)::

      {"budgets": {"max_file_loc": 800, "max_function_cx": 20,
                   "max_fanout": 15, "max_import_depth": 8}}

- ``<signal>-up``: the repository-wide total rose against the baseline;
- ``new-<signal>``: at least one file gained it since the baseline
  (``new-hotspot``, ``new-cycle``, ``new-violation``, ``new-untested`` ...).

The ``-up`` and ``new-`` forms need a baseline (``--compare REV`` or
``--baseline summary.json``); without one they cannot fire, and the report says
so rather than passing silently.
"""

from __future__ import annotations

import os

from .architecture import load_rules
from .health import _is_code
from .history import totals

TOTAL_KEYS = {
    "cycles": "cycles",
    "violations": "violations",
    "hotspots": "hotspots",
    "oversized": "oversized",
    "orphans": "orphans",
    "knowledge": "knowledge",
    "untested": "untested",
    "drift": "drift",
    "bugprone": "bugprone",
    "codes": "codes",
    "debt": "debt",
    "defects": "defects", "defect": "defects",
    "rising": "rising", "rising-hotspot": "rising", "rising-hotspots": "rising",
    "hubs": "hubs", "hub": "hubs",
    "clones": "clones", "clone": "clones",
    "hidden-coupling": "hiddenCoupling", "hiddencoupling": "hiddenCoupling",
    "zone-of-pain": "zonePain", "pain": "zonePain",
    "undeclared-dep": "undeclared",
    "undeclared": "undeclared",
}
# Budget keys a rules file may set, and how each is measured on a file.
BUDGETS = {
    "max_file_loc": ("logical lines", lambda f: f.logical_loc),
    "max_function_cx": ("decision points in one definition", lambda f: max(f.max_complexity, f.brace_complexity)),
    "max_fanout": ("resolved imports", lambda f: len(f.imports_resolved)),
    "max_import_depth": ("import depth", lambda f: f.import_depth),
}
SIGNAL_ALIASES = {
    "hotspot": "hotspot", "hotspots": "hotspot", "cycle": "cycle", "cycles": "cycle",
    "violation": "violation", "violations": "violation", "oversized": "oversized",
    "orphan": "orphan", "orphans": "orphan", "knowledge": "knowledge", "untested": "untested",
    "drift": "drift", "bugprone": "bugprone", "code": "codes", "codes": "codes",
    "defect": "defect", "defects": "defect", "rising": "rising", "rising-hotspot": "rising",
    "hub": "hub", "hubs": "hub", "clone": "clone", "clones": "clone",
    "hidden-coupling": "hiddencoupling", "hiddencoupling": "hiddencoupling",
}
LIST_LIMIT = 15


def over_budget(analysis) -> tuple[dict, list[dict], str]:
    """(budgets, files over them, error) from the repository's rules file."""
    from .health import is_vendored

    data, _path, error = load_rules(analysis.root)
    raw = (data or {}).get("budgets") or {}
    budgets = {k: int(v) for k, v in raw.items() if k in BUDGETS and isinstance(v, (int, float)) and v > 0}
    unknown = sorted(k for k in raw if k not in BUDGETS)
    if unknown and not error:
        error = f"unknown budget(s): {', '.join(unknown)}"
    over = []
    for record in analysis.files:
        if record.is_binary or record.rows is not None or is_vendored(record.rel):
            continue
        for key, limit in budgets.items():
            label, measure = BUDGETS[key]
            value = measure(record)
            if value > limit:
                over.append({"path": record.rel, "budget": key, "what": label, "value": value, "limit": limit})
    over.sort(key=lambda o: (-(o["value"] / max(1, o["limit"])), o["path"]))
    return budgets, over, error


def _pct(value: float) -> str:
    return f"{round(value * 100)}%"


def build_report(analysis, layout, delta: dict | None = None) -> dict:
    files = analysis.files
    flags = analysis.flags
    arch = analysis.architecture
    git = analysis.git

    def top(pred, key, limit=LIST_LIMIT):
        return sorted((f for f in files if pred(f)), key=key)[:limit]

    districts = []
    for district in layout.districts:
        deps = arch.districts.get(district.key) if arch is not None else None
        members = [f for f in files if f.district == district.key]
        code = [f for f in members if f.is_tested or f.is_untested]
        scores: dict[str, float] = {}
        for record in members:
            for author, score in record.expert_scores.items():
                scores[author] = scores.get(author, 0.0) + score
        districts.append({
            "folder": district.key,
            "files": district.building_count,
            "loc": district.logical_loc,
            "readme": district.has_readme,
            "ca": deps.ca if deps else 0,
            "ce": deps.ce if deps else 0,
            "instability": deps.instability if deps else None,
            "violations": deps.violations if deps else 0,
            "busFactor": district.bus_factor,
            "abstractness": deps.abstractness if deps else None,
            "distance": deps.distance if deps else None,
            "zone": deps.zone if deps else "",
            "hotspots": district.hotspots,
            "tested": f"{sum(1 for f in code if f.is_tested)}/{len(code)}" if code else "",
            "experts": [a for a, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:3]] if flags.authorship else [],
            "abstractness": deps.abstractness if deps else None,
            "distance": deps.distance if deps else None,
            "zone": deps.zone if deps else "",
            "recentAuthors": deps.recent_authors if deps else 0,
            "crossShare": deps.cross_share if deps else 0.0,
            "manyCooks": bool(deps and deps.many_cooks),
        })
    budgets, over, budget_error = over_budget(analysis)

    report = {
        "repo": os.path.basename(os.path.abspath(analysis.root)) or analysis.root,
        "head": git.head[:12] if git is not None and git.head else "",
        "files": len(files),
        "loc": analysis.total_logical_loc,
        "districts": len(layout.districts),
        "docCoverage": round(analysis.documented_files / max(1, len(files)), 4),
        "flags": {k: v for k, v in flags.to_dict().items() if k != "notes"},
        "notes": list(flags.notes),
        "rules": arch.rules if arch is not None else "",
        "totals": totals(analysis),
        "hotspots": [
            {"path": f.rel, "rank": f.hotspot_rank, "commits": f.commits, "loc": f.logical_loc}
            for f in top(lambda f: f.is_hotspot, lambda f: f.hotspot_rank)
        ] if flags.hotspots else [],
        "oversized": [
            {"path": f.rel, "loc": f.logical_loc, "longest": f.longest_floor[0] if f.longest_floor else ""}
            for f in top(lambda f: f.is_oversized, lambda f: (-f.logical_loc, f.rel))
        ],
        "cycles": [list(c) for c in analysis.cycles[:LIST_LIMIT]],
        "violations": [
            {"from": src, "to": dst, "reason": reason}
            for src, dst, reason in (arch.violations[: LIST_LIMIT * 2] if arch is not None else [])
        ],
        "knowledge": [
            {"path": f.rel, "owner": f.primary_author, "awayDays": round(f.owner_away_days)}
            for f in top(lambda f: f.knowledge_risk, lambda f: (-f.logical_loc, f.rel))
        ],
        "orphans": [f.rel for f in top(lambda f: f.is_orphan, lambda f: (-f.logical_loc, f.rel))],
        "untested": [
            {"path": f.rel, "why": ", ".join(w for w, on in (("hotspot", f.is_hotspot), ("oversized", f.is_oversized), ("downtown", f.downtown)) if on)}
            for f in top(lambda f: f.untested_risk, lambda f: (f.hotspot_rank or 10**9, -f.logical_loc))
        ],
        "drift": [
            {"path": f.rel, "declared": f.declared_owners, "actual": f.primary_author}
            for f in top(lambda f: f.owner_drift, lambda f: (-f.logical_loc, f.rel))
        ],
        "complexity": [
            {"path": f.rel, "maxComplexity": f.brace_complexity}
            for f in top(lambda f: f.is_braced, lambda f: (-f.brace_complexity, f.rel))
        ],
        "coupling": [
            {"a": a, "b": b, "pairs": n, "commits": c} for a, b, n, c in (arch.coupling if arch is not None else [])
        ],
        "impact": [
            {"path": f.rel, "files": f.impact, "folders": f.impact_folders}
            for f in top(lambda f: f.impact > 0 and not f.is_test, lambda f: (-f.impact, f.rel))
        ] if flags.imports else [],
        "bugprone": [
            {"path": f.rel, "fixes": f.fix_commits, "commits": f.commits, "reverts": f.revert_commits}
            for f in top(lambda f: f.is_bugprone, lambda f: (-f.fix_commits, -f.fix_ratio, f.rel))
        ],
        "defects": [
            {"path": f.rel, "fixes": f.fix_commits, "commits": f.commits, "ratio": f.fix_ratio}
            for f in top(lambda f: f.is_defect, lambda f: (-f.fix_ratio, -f.fix_commits, f.rel))
        ] if flags.defects else [],
        "rising": [
            {"path": f.rel, "rank": f.hotspot_rank} for f in top(lambda f: f.is_rising_hotspot, lambda f: (f.hotspot_rank, f.rel))
        ] if flags.trend else [],
        "hubs": [
            {"path": f.rel, "fanIn": f.import_in_degree, "fanOut": len(f.imports_resolved), "depth": f.import_depth}
            for f in top(lambda f: f.is_hub, lambda f: (-(f.import_in_degree + len(f.imports_resolved)), f.rel))
        ],
        "clones": [
            {"a": a, "b": b, "shared": ratio, "fingerprints": n} for a, b, ratio, n in analysis.clones[:LIST_LIMIT]
        ],
        "hiddenCoupling": [
            {"a": a, "b": b, "commits": n} for a, b, n in analysis.hidden_couplings[:LIST_LIMIT]
        ],
        "debt": [
            {"path": f.rel, "markers": len(f.debt) or f.debt_markers,
             "first": f"{f.debt[0][1]} line {f.debt[0][0]}: {f.debt[0][2]}" if f.debt else ""}
            for f in top(lambda f: bool(f.debt or f.debt_markers), lambda f: (-(len(f.debt) or f.debt_markers), f.rel))
        ] if flags.debt else [],
        "codes": [
            {"path": f.rel, "broken": list(f.code_violations)}
            for f in top(lambda f: bool(f.code_violations), lambda f: (-len(f.code_violations), f.rel))
        ],
        "zones": [
            {"folder": key, "zone": d.zone, "abstractness": d.abstractness, "instability": d.instability,
             "distance": d.distance}
            for key, d in sorted(
                ((k, d) for k, d in (arch.districts.items() if arch is not None else []) if d.zone),
                key=lambda kv: (-kv[1].distance, kv[0]),
            )
        ],
        "externals": dict(analysis.externals) if flags.externals else None,
        "budgets": budgets,
        "overBudget": over[: LIST_LIMIT * 2],
        "overBudgetCount": len(over),
        "budgetError": budget_error,
        "districtTable": sorted(districts, key=lambda d: (-(d["ca"] + d["ce"]), d["folder"])),
        "delta": None,
    }
    if delta:
        report["delta"] = {
            "baseline": delta["baseline"],
            "added": len(delta["added"]),
            "removed": len(delta["removed"]),
            "grown": [{"path": p, "lines": d} for p, d in delta["grown"][:LIST_LIMIT]],
            "shrunk": [{"path": p, "lines": d} for p, d in delta["shrunk"][:LIST_LIMIT]],
            "became": {k: v[:LIST_LIMIT] for k, v in delta["became"].items() if v},
            "resolved": {k: v for k, v in delta["resolved"].items() if v},
            "before": delta["before"],
            "after": delta["after"],
        }
    return report


def evaluate_gates(report: dict, conditions: list[str]) -> tuple[list[str], list[str]]:
    """(failures, unevaluable) for the ``--fail-on`` conditions."""
    failures: list[str] = []
    skipped: list[str] = []
    now = report["totals"]
    delta = report.get("delta")
    for raw in conditions:
        cond = raw.strip().lower()
        if not cond:
            continue
        if cond in ("budgets", "budget"):
            if not report.get("budgets"):
                skipped.append(f"{raw}: no budgets in the rules file (.zion/rules.json or zion.rules.json)")
            elif report.get("overBudgetCount"):
                first = report["overBudget"][0]
                failures.append(
                    f"{raw}: {report['overBudgetCount']} over budget, e.g. {first['path']} has "
                    f"{first['value']} {first['what']} (limit {first['limit']})"
                )
            continue
        if cond.startswith("new-"):
            signal = SIGNAL_ALIASES.get(cond[4:])
            if signal is None:
                skipped.append(f"{raw}: unknown signal")
            elif delta is None:
                skipped.append(f"{raw}: needs a baseline (--compare REV or --baseline FILE)")
            elif delta["became"].get(signal):
                failures.append(f"{raw}: {len(delta['became'][signal])} file(s) became {signal}, e.g. {delta['became'][signal][0]}")
        elif cond.endswith("-up"):
            key = TOTAL_KEYS.get(cond[:-3])
            if key is None:
                skipped.append(f"{raw}: unknown total")
            elif delta is None:
                skipped.append(f"{raw}: needs a baseline (--compare REV or --baseline FILE)")
            elif now.get(key, 0) > delta["before"].get(key, 0):
                failures.append(f"{raw}: {key} rose from {delta['before'].get(key, 0)} to {now.get(key, 0)}")
        else:
            key = TOTAL_KEYS.get(cond)
            if key is None:
                skipped.append(f"{raw}: unknown condition")
            elif now.get(key, 0) > 0:
                failures.append(f"{raw}: {now[key]} found")
    return failures, skipped


def render_markdown(report: dict) -> str:
    out: list[str] = []
    add = out.append
    add(f"# Architect's report: {report['repo']}")
    add("")
    head = f" at `{report['head']}`" if report["head"] else ""
    add(f"{report['files']:,} files, {report['loc']:,} logical lines in {report['districts']} districts{head}. "
        f"{_pct(report['docCoverage'])} of files are documented.")
    add("")
    t = report["totals"]
    add("| Signal | Now |" + (" Baseline | Change |" if report["delta"] else ""))
    add("|---|---|" + ("---|---|" if report["delta"] else ""))
    for key, label in (
        ("hotspots", "Hotspots"), ("oversized", "Oversized files"), ("cycles", "Import cycles"),
        ("violations", "Layering violations"), ("untested", "Untested risky files"), ("knowledge", "Knowledge risks"),
        ("orphans", "Possible dead code"), ("drift", "CODEOWNERS drift"), ("bugprone", "Bug-prone files"),
        ("defects", "Defect-prone files"), ("rising", "Rising hotspots"), ("hubs", "Hubs"),
        ("clones", "Clone pairs"), ("hiddenCoupling", "Hidden coupling pairs"),
        ("debt", "Debt markers"), ("codes", "Building-code breaches"), ("zonePain", "Folders in the zone of pain"),
        ("undeclared", "Undeclared packages"), ("files", "Files"), ("loc", "Logical lines"),
    ):
        row = f"| {label} | {t.get(key, 0):,} |"
        if report["delta"]:
            before = report["delta"]["before"].get(key, 0)
            change = t.get(key, 0) - before
            row += f" {before:,} | {'+' if change > 0 else ''}{change:,} |"
        add(row)
    add("")

    if report["delta"]:
        d = report["delta"]
        label = d["baseline"].get("label") or (d["baseline"].get("head") or "")[:12] or d["baseline"].get("generated", "")
        add(f"## Since {label}")
        add("")
        add(f"{d['added']} file(s) added, {d['removed']} removed, {len(d['grown'])} grown and {len(d['shrunk'])} shrunk by 10% or more.")
        for signal, paths in d["became"].items():
            add(f"- **Became {signal}:** " + ", ".join(f"`{p}`" for p in paths))
        for signal, count in d["resolved"].items():
            add(f"- **No longer {signal}:** {count} file(s)")
        if d["grown"]:
            add("- **Grew most:** " + ", ".join(f"`{g['path']}` (+{g['lines']})" for g in d["grown"][:5]))
        add("")

    def section(title, items, render, empty="None found."):
        add(f"## {title}")
        add("")
        if not items:
            add(empty)
        for item in items:
            add(f"- {render(item)}")
        add("")

    flags = report["flags"]
    section("Hotspots (change frequency × size)", report["hotspots"],
            lambda h: f"#{h['rank']} `{h['path']}` — {h['commits']} commits, {h['loc']:,} lines",
            "Disabled: too little history." if not flags.get("hotspots") else "None found.")
    section("Oversized files", report["oversized"],
            lambda o: f"`{o['path']}` — {o['loc']:,} lines" + (f"; split out `{o['longest']}` first" if o["longest"] else ""))
    section("Import cycles", report["cycles"], lambda c: " → ".join(f"`{p}`" for p in c))
    rules = report["rules"]
    section(f"Layering violations ({'rules: ' + rules if rules and rules != 'majority' else 'against the majority direction between folders'})",
            report["violations"], lambda v: f"`{v['from']}` imports `{v['to']}` — {v['reason']}",
            "No imports resolved." if not flags.get("imports") else "None found.")
    section("Untested risky files", report["untested"], lambda u: f"`{u['path']}` ({u['why']})",
            "Disabled: no test could be linked to a source file." if not flags.get("tests") else "None found.")
    section("Knowledge risk (main owner inactive 6+ months)", report["knowledge"],
            lambda k: f"`{k['path']}` — {k['owner']}, away {k['awayDays']} days")
    section("Branch-heavy code (15+ decision points)", report["complexity"],
            lambda c: f"`{c['path']}` — {c['maxComplexity']} decision points")
    if flags.get("codeowners"):
        section("CODEOWNERS drift", report["drift"],
                lambda d: f"`{d['path']}` — declared {', '.join(d['declared'])}, written by {d['actual']}")
    section("Possible dead code", report["orphans"], lambda p: f"`{p}`")
    section("Blast radius (files that transitively import it)", report["impact"],
            lambda i: f"`{i['path']}` — {i['files']:,} file(s) in {i['folders']} folder(s)",
            "No imports resolved." if not flags.get("imports") else "None found.")
    section("Bug-prone files (commits that fix them)", report["bugprone"],
            lambda b: f"`{b['path']}` — {b['fixes']} of {b['commits']} commits are fixes"
            + (f", {b['reverts']} revert(s)" if b["reverts"] else ""),
            "No commit subject names a fix." if not flags.get("defects") else "None found.")
    section("Defect-prone files (share of fix commits)", report["defects"],
            lambda d: f"`{d['path']}` — {d['fixes']} of {d['commits']} commits are fixes ({_pct(d['ratio'])})",
            "Disabled: too few commit subjects read as fixes." if not flags.get("defects") else "None found.")
    section("Rising hotspots (busier this quarter than the last)", report["rising"],
            lambda r: f"#{r['rank']} `{r['path']}`",
            "Disabled: needs 10+ commits over five months." if not flags.get("trend") else "None found.")
    section("Hubs (top tenth of both importers and imports)", report["hubs"],
            lambda h: f"`{h['path']}` — imported by {h['fanIn']}, imports {h['fanOut']}, depth {h['depth']}")
    section("Copied code (clone twins)", report["clones"],
            lambda c: f"`{c['a']}` ≈ `{c['b']}` — {_pct(c['shared'])} of the smaller file's fingerprints shared")
    section("Hidden coupling (change together, no import)", report["hiddenCoupling"],
            lambda h: f"`{h['a']}` ↔ `{h['b']}` — {h['commits']} shared commits",
            "Disabled: too little history or no resolved imports." if not flags.get("coupling") else "None found.")
    section("Written-down debt (TODO / FIXME / HACK)", report["debt"],
            lambda d: f"`{d['path']}` — {d['markers']} marker(s)" + (f"; {d['first']}" if d["first"] else ""))
    if report["codes"] or flags.get("codes"):
        section("Building-code breaches (.zion/rules.json)", report["codes"],
                lambda c: f"`{c['path']}` — " + "; ".join(c["broken"]))
    if report.get("budgets") or report.get("budgetError"):
        limits = ", ".join(f"{k} {v}" for k, v in report["budgets"].items())
        section(f"Over budget ({limits or 'no valid budgets'})", report["overBudget"],
                lambda o: f"`{o['path']}` — {o['value']} {o['what']} (limit {o['limit']})",
                report.get("budgetError") or "Every file is within budget.")
    section("Main sequence: folders far from A + I = 1", report["zones"],
            lambda z: f"`{z['folder']}` — zone of {z['zone']} (A {z['abstractness']:.2f}, I {z['instability']:.2f}, "
            f"D {z['distance']:.2f})")
    ext = report["externals"]
    if ext:
        add("## External dependencies")
        add("")
        add(f"{ext['total']} third-party package(s); manifests: "
            + (", ".join(f"`{m}`" for m in ext["manifests"]) or "none found") + ".")
        add("")
        add("| Package | Ecosystem | Files | Folders | Declared |")
        add("|---|---|---|---|---|")
        for p in ext["packages"][:LIST_LIMIT]:
            declared = "yes" if p["declared"] else ("**no**" if ext["manifests"] else "—")
            add(f"| `{p['name']}` | {p['ecosystem']} | {p['files']} | {p['folders']} | {declared} |")
        add("")
        if ext["undeclared"]:
            add("- **Imported, not declared:** " + ", ".join(f"`{n}`" for n in ext["undeclared"]))
        if ext["unused"]:
            add("- **Declared, never imported:** " + ", ".join(f"`{n}`" for n in ext["unused"]))
        add("")
    section("Folders that change together", report["coupling"],
            lambda c: f"`{c['a']}` ↔ `{c['b']}` — {c['pairs']} file pairs, {c['commits']} shared commits",
            "Disabled: too little history." if not flags.get("coupling") else "None found.")

    add("## Folders")
    add("")
    add("| Folder | Files | Lines | Ca | Ce | Instability | A | D | Violations | Bus factor | Recent people | Tested | Ask |")
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for d in report["districtTable"]:
        inst = "—" if d["instability"] is None else f"{d['instability']:.2f}"
        a = "—" if d.get("abstractness") is None else f"{d['abstractness']:.2f}"
        dist = "—" if d.get("distance") is None else f"{d['distance']:.2f}" + (f" ({d['zone']})" if d.get("zone") else "")
        people = str(d.get("recentAuthors", 0)) + (" (many cooks)" if d.get("manyCooks") else "")
        add(f"| `{d['folder']}` | {d['files']} | {d['loc']:,} | {d['ca']} | {d['ce']} | {inst} | {a} | {dist} | "
            f"{d['violations']} | {d['busFactor']} | {people} | {d['tested'] or '—'} | {', '.join(d['experts']) or '—'} |")
    add("")
    if report["notes"]:
        add("## Notes")
        add("")
        for note in report["notes"]:
            add(f"- {note}")
        add("")
    return "\n".join(out)

