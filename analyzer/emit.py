"""Emit the city: manifest, district chunks, floor detail and the string table.

Everything human-readable -- paths, names, authors, docstrings, stats labels --
lives in the string table and is referenced by integer index.  That is what makes
``--encrypt`` a clean swap rather than a re-serialization: the geometry in
``city.json`` and ``d/*.json`` is byte-identical locked or unlocked, and only
``strings.bin`` plus the ``f/*`` payloads change.

Source bodies are written to ``f/<id>.src`` as raw bytes with byte offsets
recorded in ``f/<id>.json``.  Interiors carry full source by explicit choice, and
a 10.8 MB HTML corpus would inflate noticeably if every page were JSON-escaped.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from . import parse as parse_pkg
from .layout import CityLayout, DistrictLayout, build_layout
from .metrics import FileMetrics, RepoAnalysis

FORMAT = "zion-city"
VERSION = 1
STRING_MAGIC = b"ZIONSTR1"

# Legend entries, in display order.  `enabled` is decided by RepoFlags.
LEGEND_SPEC = [
    ("height", "Logical source lines -> building height", "loc"),
    ("footprint", "Size on disk (capped) -> footprint", "bytes"),
    ("floors", "Functions, classes, headings, cells -> floors", "count"),
    ("district_area", "Folder content weight -> district area", "weight"),
    ("author_tint", "Dominant author -> building tint and Mayor", "authors"),
    ("churn", "Commits touching the file -> window traffic, cranes", "commits"),
    ("weathering", "Days since last commit -> weathering", "days"),
    ("lit_windows", "Docstring + comment ratio -> lit windows", "ratio"),
    ("town_hall", "README in folder -> Town Hall", "bool"),
    ("parks", "Test files -> parks", "bool"),
    ("silos", "Data files -> silos (height = rows)", "rows"),
    ("monuments", "Binary artefacts -> monuments", "bool"),
    ("skybridges", "Files changed in one commit -> skybridges", "pairs"),
]


class StringTable:
    """Deduplicating string interning with stable integer indices."""

    def __init__(self) -> None:
        self._strings: list[str] = []
        self._index: dict[str, int] = {}

    def add(self, value: str | None) -> int:
        if value is None:
            value = ""
        existing = self._index.get(value)
        if existing is not None:
            return existing
        position = len(self._strings)
        self._index[value] = position
        self._strings.append(value)
        return position

    def __len__(self) -> int:
        return len(self._strings)

    def to_bytes(self) -> bytes:
        out = bytearray()
        out += STRING_MAGIC
        out += len(self._strings).to_bytes(4, "little")
        for value in self._strings:
            raw = value.encode("utf-8")
            out += len(raw).to_bytes(4, "little")
            out += raw
        return bytes(out)


@dataclass
class EmitOptions:
    encrypt: bool = False
    passphrase: str | None = None
    single_file: bool = False
    include_source: bool = True
    max_floor_detail: int | None = None


@dataclass
class EmitResult:
    out_dir: str
    manifest: dict = field(default_factory=dict)
    strings: StringTable | None = None
    bytes_written: int = 0
    encrypted: bool = False
    encryption_seconds: float = 0.0
    source_bytes: int = 0


def _write(path: str, data: bytes) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def _json(data) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _camera(bounds_w: float, bounds_h: float, max_height: float) -> dict:
    span = max(bounds_w, bounds_h)
    centre_x = bounds_w / 2.0
    centre_z = bounds_h / 2.0
    # Look at a point partway up the skyline, from outside the city and high
    # enough to see the whole footprint.
    target_y = max(6.0, max_height * 0.28)
    return {
        "eye": [centre_x, span * 0.55, centre_z + span * 1.35],
        "target": [centre_x, target_y, centre_z],
        "fov": 55.0,
        "near": 0.5,
        "far": max(2000.0, span * 8.0),
    }


def build_manifest(
    analysis: RepoAnalysis,
    layout: CityLayout,
    strings: StringTable,
    options: EmitOptions,
    crypto_meta: dict | None,
) -> dict:
    buildings_total = len(analysis.files)
    max_height = max((f.height for f in analysis.files), default=0.0)

    flags = analysis.flags
    legend = []
    enable_map = {
        "author_tint": flags.authorship,
        "churn": flags.churn,
        "weathering": flags.recency,
        "skybridges": flags.coupling,
    }
    for entry_id, label, unit in LEGEND_SPEC:
        enabled = enable_map.get(entry_id, True)
        legend.append(
            {
                "id": entry_id,
                "label": strings.add(label),
                "unit": unit,
                "enabled": enabled,
            }
        )

    # ---- districts, with skyline envelopes for the overview impostors ----
    districts = []
    for index, district in enumerate(layout.districts):
        members = [f for f in analysis.files if f.district == district.key]
        heights = [f.height for f in members] or [0.0]
        envelope_w = max((b.width for b in district.buildings), default=0.0)
        envelope_d = max((b.depth for b in district.buildings), default=0.0)
        districts.append(
            {
                "id": index,
                "key": strings.add(district.key),
                "name": strings.add(district.name),
                "rect": [
                    round(district.rect.x, 3),
                    round(district.rect.y, 3),
                    round(district.rect.w, 3),
                    round(district.rect.h, 3),
                ],
                "buildings": district.building_count,
                "weight": round(district.weight, 3),
                "hasReadme": district.has_readme,
                "readmeRel": strings.add(district.readme_rel) if district.readme_rel else -1,
                "mayor": strings.add(district.mayor) if district.mayor else -1,
                "primaryLanguage": strings.add(district.primary_language),
                "logicalLoc": district.logical_loc,
                "documented": district.documented,
                "testFiles": district.test_files,
                "dataFiles": district.data_files,
                "skyline": {
                    "maxHeight": round(max(heights), 2),
                    "avgHeight": round(sum(heights) / len(heights), 2),
                    "envelope": [round(envelope_w, 2), round(envelope_d, 2)],
                },
                "chunk": f"d/{index:04d}.json",
            }
        )

    # ---- repo-wide stats for City Hall ----
    languages: dict[str, dict] = {}
    for record in analysis.files:
        bucket = languages.setdefault(record.language, {"files": 0, "loc": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["loc"] += record.logical_loc
        bucket["bytes"] += record.size
    language_rows = [
        {"name": strings.add(name), "files": v["files"], "loc": v["loc"], "bytes": v["bytes"]}
        for name, v in sorted(languages.items(), key=lambda kv: -kv[1]["loc"])
    ]

    author_rows = []
    if flags.authorship:
        owners: dict[str, dict] = {}
        for record in analysis.files:
            for author, lines in record.authors.items():
                entry = owners.setdefault(author, {"lines": 0, "files": 0})
                entry["lines"] += lines
                entry["files"] += 1
        author_rows = [
            {"name": strings.add(name), "lines": v["lines"], "files": v["files"]}
            for name, v in sorted(owners.items(), key=lambda kv: -kv[1]["lines"])
        ]

    largest = sorted(analysis.files, key=lambda f: -f.logical_loc)[:12]
    largest_rows = [
        {
            "path": strings.add(f.rel),
            "loc": f.logical_loc,
            "bytes": f.size,
            "language": strings.add(f.language),
            "floors": len(f.floors),
            "documented": round(f.doc_ratio, 3),
        }
        for f in largest
    ]

    folder_rows = [
        {
            "name": strings.add(d.key),
            "buildings": d.building_count,
            "loc": d.logical_loc,
            "hasReadme": d.has_readme,
            "documented": d.documented,
            "language": strings.add(d.primary_language),
        }
        for d in layout.districts
    ]

    districts_with_readme = sum(1 for d in layout.districts if d.has_readme)
    documented_files = analysis.documented_files
    doc_coverage = documented_files / max(1, buildings_total)

    notes = [strings.add(note) for note in flags.notes]
    if not districts_with_readme:
        notes.append(strings.add("No district has its own README."))

    stats = {
        "fileCount": buildings_total,
        "districtCount": len(layout.districts),
        "logicalLoc": analysis.total_logical_loc,
        "totalBytes": analysis.total_bytes,
        "documentedFiles": documented_files,
        "docCoverage": round(doc_coverage, 4),
        "districtsWithReadme": districts_with_readme,
        "districtsTotal": len(layout.districts),
        "languages": language_rows,
        "authors": author_rows,
        "largestFiles": largest_rows,
        "folders": folder_rows,
        "notes": notes,
    }

    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "meta": {
            "generated": _now_iso(),
            "walker": analysis.walk_source,
            "noiseExcluded": analysis.noise_excluded,
            "truncated": analysis.truncated,
            "districtDepth": layout.depth,
            "buildingCount": buildings_total,
            "sourceMode": "full" if options.include_source else "none",
            "encrypted": bool(options.encrypt),
        },
        "crypto": crypto_meta,
        "flags": flags.to_dict(),
        "legend": legend,
        "bounds": [
            round(layout.bounds.x, 3),
            round(layout.bounds.y, 3),
            round(layout.bounds.w, 3),
            round(layout.bounds.h, 3),
        ],
        "streets": [[round(s.x, 2), round(s.y, 2), round(s.w, 2), round(s.h, 2)] for s in layout.streets],
        "camera": _camera(layout.bounds.w, layout.bounds.h, max_height),
        "districts": districts,
        "stats": stats,
    }
    return manifest


def _now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Viewer installation
# --------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def install_viewer(out_dir: str) -> int:
    """Copy the viewer and its vendored three.js next to the city data.

    The output directory becomes the whole website: `zion serve` only has to
    serve one folder, and a build stays self-contained when archived.
    """
    import shutil

    written = 0
    viewer = os.path.join(REPO_ROOT, "viewer")
    vendor = os.path.join(REPO_ROOT, "vendor")

    os.makedirs(os.path.join(out_dir, "js"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "css"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "vendor"), exist_ok=True)

    for rel in ("index.html", os.path.join("css", "hud.css")):
        destination = os.path.join(out_dir, rel)
        shutil.copyfile(os.path.join(viewer, rel), destination)
        written += os.path.getsize(destination)

    for name in sorted(os.listdir(os.path.join(viewer, "js"))):
        if not name.endswith(".js"):
            continue
        destination = os.path.join(out_dir, "js", name)
        shutil.copyfile(os.path.join(viewer, "js", name), destination)
        written += os.path.getsize(destination)

    three = os.path.join(vendor, "three.module.js")
    if os.path.exists(three):
        destination = os.path.join(out_dir, "vendor", "three.module.js")
        shutil.copyfile(three, destination)
        written += os.path.getsize(destination)

    return written


# --------------------------------------------------------------------------
# Chunks and floor detail
# --------------------------------------------------------------------------


def _building_record(
    index: int,
    record: FileMetrics,
    strings: StringTable,
    district_id: int,
    placed=None,
) -> dict:
    placement = {
        "x": round(placed.x, 3) if placed else 0.0,
        "y": round(placed.y, 3) if placed else 0.0,
        "width": round(placed.width, 3) if placed else 4.0,
        "depth": round(placed.depth, 3) if placed else 4.0,
    }
    return {
        "id": index,
        **placement,
        "district": district_id,
        "name": strings.add(record.name),
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "archetype": record.archetype,
        "loc": record.logical_loc,
        "physicalLines": record.physical_lines,
        "bytes": record.size,
        "floors": len(record.floors),
        "docRatio": round(record.doc_ratio, 4),
        "lit": None if record.lit_windows is None else round(record.lit_windows, 4),
        "isTest": record.is_test,
        "isDoc": record.is_doc,
        "isBinary": record.is_binary,
        "isRuin": record.is_ruin,
        "rows": record.rows,
        "conf": record.confidence,
        "parseConfidence": record.parse_confidence,
        "commits": record.commits,
        "churn": record.churn,
        "recencyDays": round(record.recency_days, 1),
        "author": strings.add(record.primary_author) if record.primary_author else -1,
        "ownership": round(record.ownership_share, 3),
        "lastMessage": strings.add(record.last_message) if record.last_message else -1,
        "height": round(record.height, 2),
        "footprint": round(record.footprint, 2),
        "detail": f"f/{index}.json",
        "source": f"f/{index}.src" if _includes_source(record) else "",
    }


def _includes_source(record: FileMetrics) -> bool:
    return not record.is_binary and record.size > 0


def _floor_payload(record: FileMetrics, strings: StringTable) -> tuple[dict, bytes]:
    """Build ``f/<id>.json`` plus the raw ``f/<id>.src`` bytes.

    Floors carry byte offsets into the source blob rather than escaped text, so
    the viewer can slice exactly what the parser saw without JSON escaping a
    10 MB HTML corpus.
    """
    if record.is_binary:
        # The path is interned, not written literally: a locked city must not
        # leak a filename through the floor detail file.
        return (
            {
                "id": None,
                "path": strings.add(record.rel),
                "language": strings.add(record.language),
                "binary": True,
                "bytes": record.size,
                "srcBytes": 0,
                "floors": [],
            },
            b"",
        )

    try:
        source = parse_pkg.read_text(record.abspath)
    except OSError:
        source = ""

    # A notebook's useful source is its cell source, not the ipynb JSON wrapper
    # (which is mostly base64 image output).  Concatenate the cells so the
    # floors' offsets point at readable code.
    if record.language == "notebook":
        return _notebook_payload(record, strings, source)

    blob = source.encode("utf-8", errors="replace")

    # Offsets are computed over the encoded blob so multi-byte characters in
    # docstrings do not shift a floor's slice.  ``offsets[0]`` is the start of
    # line 1, so line N starts at ``offsets[N - 1]``; floor spans are half-open
    # ``[line, end_line)`` to match every parser.
    offsets = _line_offsets(blob)
    last = len(offsets) - 1
    floors = []
    for floor in record.floors:
        start_line = max(1, min(floor.line or 1, last + 1))
        end_line = max(start_line + 1, floor.end_line or (start_line + 1))
        start = offsets[start_line - 1]
        end = offsets[min(end_line - 1, last)]
        floors.append(
            {
                "name": strings.add(floor.name),
                "kind": floor.kind,
                "doc": strings.add(floor.doc) if floor.doc else -1,
                "line": floor.line,
                "endLine": floor.end_line,
                "loc": floor.loc,
                "depth": floor.depth,
                "srcOffset": start,
                "srcLength": max(0, end - start),
            }
        )

    payload = {
        "id": None,
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "loc": record.logical_loc,
        "binary": False,
        "srcBytes": len(blob),
        "floors": floors,
    }
    return payload, blob


def _notebook_payload(record: FileMetrics, strings: StringTable, source: str) -> tuple[dict, bytes]:
    """Cell source, not the ipynb wrapper, is what a notebook's interior shows."""
    import json as _jsonlib

    try:
        doc = _jsonlib.loads(source)
    except ValueError:
        doc = {}
    cells = doc.get("cells") if isinstance(doc, dict) else None
    if not isinstance(cells, list):
        cells = []
        for sheet in (doc.get("worksheets") if isinstance(doc, dict) else None) or []:
            if isinstance(sheet, dict):
                cells.extend(sheet.get("cells") or [])

    blob = bytearray()
    floors = []
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        kind = cell.get("cell_type")
        raw = cell.get("source") or cell.get("input") or ""
        if isinstance(raw, list):
            raw = "".join(str(p) for p in raw)
        text = str(raw)
        if not text.strip():
            continue
        encoded = text.encode("utf-8", errors="replace")
        start = len(blob)
        blob += encoded
        if not text.endswith("\n"):
            blob += b"\n"
        first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        floors.append(
            {
                "name": strings.add(_trim(first, 80) or ("cell" if kind == "code" else "note")),
                "kind": "cell" if kind == "code" else "heading",
                "doc": strings.add(_trim(first)) if first else -1,
                "line": 0,
                "endLine": 0,
                "loc": len(encoded),
                "depth": 0,
                "srcOffset": start,
                "srcLength": len(encoded),
            }
        )

    payload = {
        "id": None,
        "path": strings.add(record.rel),
        "language": strings.add(record.language),
        "loc": record.logical_loc,
        "binary": False,
        "srcBytes": len(blob),
        "floors": floors,
    }
    return payload, bytes(blob)


def _trim(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def _line_offsets(blob: bytes) -> list[int]:
    """Byte offset of each line start, found at C speed."""
    offsets = [0]
    position = blob.find(b"\n")
    while position != -1:
        offsets.append(position + 1)
        position = blob.find(b"\n", position + 1)
    return offsets


# --------------------------------------------------------------------------
# Top-level emit
# --------------------------------------------------------------------------


def emit_city(
    analysis: RepoAnalysis,
    out_dir: str,
    options: EmitOptions | None = None,
    layout: CityLayout | None = None,
    progress=None,
) -> EmitResult:
    options = options or EmitOptions()
    layout = layout or build_layout(analysis)
    strings = StringTable()
    result = EmitResult(out_dir=out_dir, strings=strings, encrypted=options.encrypt)

    crypto_meta = None
    encryptor = None
    if options.encrypt:
        from . import crypto

        if not options.passphrase:
            raise ValueError("--encrypt requires a passphrase (ZION_PASSPHRASE or prompt)")
        crypto_meta, encryptor = crypto.prepare(options.passphrase)

    manifest = build_manifest(analysis, layout, strings, options, crypto_meta)

    # ---- district chunks ----
    by_district: dict[str, list[FileMetrics]] = {}
    for record in analysis.files:
        by_district.setdefault(record.district, []).append(record)

    district_order = {d.key: i for i, d in enumerate(layout.districts)}
    # Placement is computed by layout, so carry it into the chunk records: the
    # viewer positions instances from the chunk, not from the manifest.
    placement = {
        b.rel: b for district in layout.districts for b in district.buildings
    }
    building_index: dict[str, int] = {}
    counter = 0
    for key in sorted(by_district, key=lambda k: district_order.get(k, 0)):
        for record in sorted(by_district[key], key=lambda f: f.rel):
            building_index[record.rel] = counter
            counter += 1

    bytes_written = 0
    source_bytes = 0

    for key, members in by_district.items():
        district_id = district_order.get(key, 0)
        records = [
            _building_record(
                building_index[m.rel], m, strings, district_id, placement.get(m.rel)
            )
            for m in sorted(members, key=lambda f: f.rel)
        ]
        payload = _json({"district": district_id, "buildings": records})
        bytes_written += _write(os.path.join(out_dir, f"d/{district_id:04d}.json"), payload)
        if progress:
            progress(f"district {district_id:04d} {key}")

    # ---- floor detail ----
    import time as _time

    crypto_seconds = 0.0
    for record in analysis.files:
        index = building_index[record.rel]
        payload, blob = _floor_payload(record, strings)
        payload["id"] = index
        detail_bytes = _json(payload)
        if encryptor is not None:
            started = _time.time()
            detail_bytes = encryptor(detail_bytes, f"f/{index}.json")
            crypto_seconds += _time.time() - started
        bytes_written += _write(os.path.join(out_dir, f"f/{index}.json"), detail_bytes)

        if blob and options.include_source:
            source_bytes += len(blob)
            if encryptor is not None:
                started = _time.time()
                blob = encryptor(blob, f"f/{index}.src")
                crypto_seconds += _time.time() - started
            bytes_written += _write(os.path.join(out_dir, f"f/{index}.src"), blob)
        elif not blob:
            # Emit an empty source file so the viewer's fetch path is uniform.
            empty = b"" if encryptor is None else encryptor(b"", f"f/{index}.src")
            bytes_written += _write(os.path.join(out_dir, f"f/{index}.src"), empty)

    # ---- rebuild manifest with the complete string table ----
    strings_bytes = strings.to_bytes()
    if encryptor is not None:
        started = _time.time()
        strings_bytes = encryptor(strings_bytes, "strings.bin")
        crypto_seconds += _time.time() - started
    bytes_written += _write(os.path.join(out_dir, "strings.bin"), strings_bytes)

    manifest = build_manifest(analysis, layout, strings, options, crypto_meta)
    manifest["stringTable"] = {"count": len(strings), "bytes": len(strings_bytes)}
    bytes_written += _write(os.path.join(out_dir, "city.json"), _json(manifest))

    bytes_written += install_viewer(out_dir)

    result.manifest = manifest
    result.bytes_written = bytes_written
    result.source_bytes = source_bytes
    result.encryption_seconds = crypto_seconds
    return result
