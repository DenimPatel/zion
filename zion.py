#!/usr/bin/env python3
"""Zion -- turn any repository into an explorable 3D city.

    python3 zion.py stats  <repo>            # text report, no 3D at all
    python3 zion.py build  <repo> [-o DIR]   # write a city
    python3 zion.py serve  <repo>            # build if needed, serve, open
    python3 zion.py bench  generate          # synthetic repo for 50k testing

Pure standard library.  No npm, no Node, no third-party packages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analyzer import emit as emit_mod
from analyzer.gitmeta import read_git_index
from analyzer.layout import build_layout, choose_depth, district_counts
from analyzer.metrics import analyze
from analyzer.walk import FileWalker


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def cache_dir_for(root: str) -> str:
    """Build output outside the analyzed repo, so analyzing never writes to it."""
    base = os.environ.get("ZION_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "zion"
    )
    slug = os.path.basename(os.path.abspath(root).rstrip("/")) or "repo"
    digest = hashlib.sha256(os.path.abspath(root).encode("utf-8")).hexdigest()[:10]
    return os.path.join(base, f"{slug}-{digest}")


def prepare_analysis(root: str, include_noise: bool, max_buildings: int | None):
    walk = FileWalker(root, include_noise=include_noise, max_buildings=max_buildings).walk()
    git = read_git_index(os.path.abspath(root), {entry.rel for entry in walk.files})
    analysis = analyze(os.path.abspath(root), walk.files, git, include_noise=include_noise)
    analysis.walk_source = walk.source
    analysis.noise_excluded = walk.noise_excluded
    analysis.truncated = walk.truncated
    return analysis


def human_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:,.1f} {unit}" if unit != "B" else f"{int(size):,} B"
        size /= 1024
    return f"{size:,.1f} GB"


def human_int(value: int) -> str:
    return f"{value:,}"


# --------------------------------------------------------------------------
# stats
# --------------------------------------------------------------------------


def cmd_stats(args) -> int:
    analysis = prepare_analysis(args.repo, args.include_noise, args.max_buildings)
    layout = build_layout(analysis, args.district_depth)

    archetypes: dict[str, int] = {}
    language_stats: dict[str, dict[str, int]] = {}
    for record in analysis.files:
        archetypes[record.archetype] = archetypes.get(record.archetype, 0) + 1
        bucket = language_stats.setdefault(
            record.language, {"files": 0, "loc": 0, "physical": 0, "bytes": 0}
        )
        bucket["files"] += 1
        bucket["loc"] += record.logical_loc
        bucket["physical"] += record.physical_lines
        bucket["bytes"] += record.size

    payload = {
        "root": analysis.root,
        "walker": analysis.walk_source,
        "files": len(analysis.files),
        "bytes": analysis.total_bytes,
        "logical_loc": analysis.total_logical_loc,
        "physical_lines": sum(f.physical_lines for f in analysis.files),
        "noise_excluded": analysis.noise_excluded,
        "truncated": analysis.truncated,
        "district_depth": layout.depth,
        "districts": len(layout.districts),
        "district_depth_candidates": district_counts(analysis.files, 4),
        "auto_depth": choose_depth(analysis.files),
        "languages": language_stats,
        "archetypes": archetypes,
        "flags": analysis.flags.to_dict(),
        "documented_files": analysis.documented_files,
    }

    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    flags = analysis.flags
    print(f"Zion -- {os.path.basename(analysis.root) or analysis.root}")
    print(f"  root               {analysis.root}")
    print(f"  walker             {analysis.walk_source}"
          + (f"  ({analysis.noise_excluded} files hidden by .gitignore)" if analysis.noise_excluded else ""))
    print(f"  files              {human_int(len(analysis.files))}"
          + ("  (truncated)" if analysis.truncated else ""))
    print(f"  bytes on disk      {human_bytes(analysis.total_bytes)}")
    print(f"  physical lines     {human_int(payload['physical_lines'])}")
    print(f"  logical source     {human_int(analysis.total_logical_loc)}")
    print(f"  documented         {analysis.documented_files} files "
          f"({analysis.documented_files / max(1, len(analysis.files)):.0%})")
    print(f"  districts          {len(layout.districts)} at depth {layout.depth} "
          f"(candidates {payload['district_depth_candidates']})")

    print("  languages")
    for name, bucket in sorted(language_stats.items(), key=lambda kv: -kv[1]["loc"]):
        print(
            f"      {name:<12} {bucket['files']:>5} files  "
            f"{bucket['loc']:>9,} logical  {bucket['physical']:>9,} lines  "
            f"{human_bytes(bucket['bytes']):>10}"
        )

    print("  archetypes         " + ", ".join(
        f"{k}={v}" for k, v in sorted(archetypes.items(), key=lambda kv: -kv[1])
    ))
    print(f"  legend enabled     authorship={flags.authorship} churn={flags.churn} "
          f"weathering={flags.recency} skybridges={flags.coupling}")
    for note in flags.notes:
        print(f"      note: {note}")
    missing = [d for d in layout.districts if not d.has_readme]
    print(f"  town halls         {len(layout.districts) - len(missing)} of "
          f"{len(layout.districts)} districts have a README")
    return 0


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------


def cmd_build(args) -> int:
    import time

    root = args.repo
    started = time.time()
    analysis = prepare_analysis(root, args.include_noise, args.max_buildings)
    layout = build_layout(analysis, args.district_depth)
    elapsed_analysis = time.time() - started

    out_dir = args.output or os.path.join(os.getcwd(), "out")
    passphrase = None
    if args.encrypt:
        passphrase = os.environ.get("ZION_PASSPHRASE")
        if not passphrase:
            import getpass

            passphrase = getpass.getpass("Zion passphrase: ")
            if not passphrase:
                print("error: empty passphrase", file=sys.stderr)
                return 2

    options = emit_mod.EmitOptions(
        encrypt=args.encrypt,
        passphrase=passphrase,
        single_file=args.single_file,
        include_source=not args.no_source,
    )
    result = emit_mod.emit_city(analysis, out_dir, options, layout=layout)

    total = time.time() - started
    print(f"Zion built {os.path.basename(os.path.abspath(root)) or root}")
    print(f"  output        {out_dir}")
    print(f"  buildings     {len(analysis.files)} in {len(layout.districts)} districts")
    print(f"  source        {human_bytes(result.source_bytes)} of source written")
    print(f"  city size     {human_bytes(result.bytes_written)}")
    print(f"  analyze       {elapsed_analysis:.2f}s")
    print(f"  total         {total:.2f}s")
    if args.encrypt:
        print(f"  encrypted     yes ({result.encryption_seconds:.2f}s of AES-GCM)")
    else:
        print("  encrypted     no (plain city, real labels)")
    return 0


# --------------------------------------------------------------------------
# serve
# --------------------------------------------------------------------------


def cmd_serve(args) -> int:
    import functools
    import http.server
    import socketserver
    import threading
    import webbrowser

    out_dir = args.output or cache_dir_for(args.repo)
    index = os.path.join(out_dir, "city.json")
    if args.no_rebuild or not os.path.exists(index):
        if not args.no_rebuild:
            build_args = argparse.Namespace(
                repo=args.repo,
                output=out_dir,
                encrypt=False,
                single_file=False,
                include_noise=args.include_noise,
                district_depth=args.district_depth,
                max_buildings=args.max_buildings,
                no_source=False,
            )
            cmd_build(build_args)

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=out_dir, **kw)

        def log_message(self, *a):  # pragma: no cover - noise control
            pass

    with socketserver.TCPServer(("127.0.0.1", args.port), QuietHandler) as httpd:
        url = f"http://127.0.0.1:{httpd.server_address[1]}/"
        print(f"Zion serving {out_dir}")
        print(f"  {url}")
        if args.open:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


# --------------------------------------------------------------------------
# bench
# --------------------------------------------------------------------------


def cmd_bench(args) -> int:
    from bench import generate_repo

    if args.action == "generate":
        target = args.dir or os.path.join(os.getcwd(), "bench", "tmp", f"repo-{args.files}")
        path = generate_repo.generate(target, args.files)
        print(f"generated {args.files} files at {path}")
        return 0
    print(f"bench action '{args.action}' is not implemented yet", file=sys.stderr)
    return 2


# --------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zion", description="Turn a repository into an explorable 3D city."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("repo", help="path to the repository to analyze")
    common.add_argument("--include-noise", action="store_true",
                        help="include files ignored by .gitignore, rendered as ruins")
    common.add_argument("--district-depth", type=int, default=None,
                        help="override the automatic district depth")
    common.add_argument("--max-buildings", type=int, default=None,
                        help="cap the number of buildings (for very large repos)")

    p_stats = sub.add_parser("stats", parents=[common], help="text report, no 3D")
    p_stats.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    p_stats.set_defaults(func=cmd_stats)

    p_build = sub.add_parser("build", parents=[common], help="write a city")
    p_build.add_argument("-o", "--output", default=None, help="output directory")
    p_build.add_argument("--encrypt", action="store_true",
                         help="encrypt the string table and floor detail (AES-256-GCM)")
    p_build.add_argument("--single-file", action="store_true",
                         help="inline everything into one city.html (small repos only)")
    p_build.add_argument("--no-source", action="store_true",
                         help="omit interior source bodies")
    p_build.set_defaults(func=cmd_build)

    p_serve = sub.add_parser("serve", parents=[common], help="build if needed and serve")
    p_serve.add_argument("-o", "--output", default=None, help="output directory")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.add_argument("--open", action="store_true", help="open a browser")
    p_serve.add_argument("--no-rebuild", action="store_true", help="serve the existing build")
    p_serve.set_defaults(func=cmd_serve)

    p_bench = sub.add_parser("bench", help="synthetic scale benchmark")
    p_bench.add_argument("action", choices=["generate", "run"], default="generate", nargs="?")
    p_bench.add_argument("--files", type=int, default=50000)
    p_bench.add_argument("--dir", default=None)
    p_bench.set_defaults(func=cmd_bench)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
