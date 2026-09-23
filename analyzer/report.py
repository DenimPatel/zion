"""The architect's report: the city's findings as Markdown or JSON, and a CI gate.

``python3 zion.py report <repo>`` prints what the City Guide's Health tab and
the inspectors show, as text a pull request, a wiki page or a CI log can
carry. ``--fail-on`` turns it into a gate: the command exits 1 when a named
condition holds, so a pipeline can refuse a change that adds an import cycle
or a layering violation.

Gate conditions (comma-separated):

- ``<signal>``: any file carries it now -- ``cycles``, ``violations``,
  ``hotspots``, ``oversized``, ``orphans``, ``knowledge``, ``untested``,
  ``drift``;
- ``<signal>-up``: the repository-wide total rose against the baseline;
- ``new-<signal>``: at least one file gained it since the baseline
  (``new-hotspot``, ``new-cycle``, ``new-violation``, ``new-untested`` ...).

The ``-up`` and ``new-`` forms need a baseline (``--compare REV`` or
``--baseline summary.json``); without one they cannot fire, and the report says
so rather than passing silently.
"""

from __future__ import annotations

import os

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
}
SIGNAL_ALIASES = {
    "hotspot": "hotspot", "hotspots": "hotspot", "cycle": "cycle", "cycles": "cycle",
    "violation": "violation", "violations": "violation", "oversized": "oversized",
    "orphan": "orphan", "orphans": "orphan", "knowledge": "knowledge", "untested": "untested",
    "drift": "drift",
}
LIST_LIMIT = 15


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
            "hotspots": district.hotspots,
            "tested": f"{sum(1 for f in code if f.is_tested)}/{len(code)}" if code else "",
            "experts": [a for a, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:3]] if flags.authorship else [],
        })

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
        ("orphans", "Possible dead code"), ("drift", "CODEOWNERS drift"), ("files", "Files"), ("loc", "Logical lines"),
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
    section("Folders that change together", report["coupling"],
            lambda c: f"`{c['a']}` ↔ `{c['b']}` — {c['pairs']} file pairs, {c['commits']} shared commits",
            "Disabled: too little history." if not flags.get("coupling") else "None found.")

    add("## Folders")
    add("")
    add("| Folder | Files | Lines | Ca | Ce | Instability | Violations | Bus factor | Tested | Ask |")
    add("|---|---|---|---|---|---|---|---|---|---|")
    for d in report["districtTable"]:
        inst = "—" if d["instability"] is None else f"{d['instability']:.2f}"
        add(f"| `{d['folder']}` | {d['files']} | {d['loc']:,} | {d['ca']} | {d['ce']} | {inst} | {d['violations']} | "
            f"{d['busFactor']} | {d['tested'] or '—'} | {', '.join(d['experts']) or '—'} |")
    add("")
    if report["notes"]:
        add("## Notes")
        add("")
        for note in report["notes"]:
            add(f"- {note}")
        add("")
    return "\n".join(out)

