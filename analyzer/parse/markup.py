"""Markdown and HTML parsing.

Both formats turn structure into floors.  For Markdown the floor plan *is* the
heading tree.  For HTML -- which is the dominant language in a large
self-contained site, e.g. 284 pages / 152,362 lines in the reference repo --
headings give the floors and every inline ``<script>`` block is handed to the
brace scanner so real functions show up as real floors too.
"""

from __future__ import annotations

import re

from . import Floor, ParseResult, _shorten

# --------------------------------------------------------------------------
# Markdown
# --------------------------------------------------------------------------

_ATX = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def parse_markdown(source: str) -> ParseResult:
    lines = source.splitlines()
    floors: list[Floor] = []
    in_fence = False
    fence_marker = ""
    prose = 0
    logical = 0

    for i, raw in enumerate(lines, 1):
        stripped = raw.strip()
        fence = _FENCE.match(raw)
        if fence:
            marker = fence.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            continue
        if not stripped:
            continue
        logical += 1
        if in_fence:
            continue
        heading = _ATX.match(raw)
        if heading:
            floors.append(
                Floor(
                    name=_shorten(heading.group(2), 80) or "(untitled)",
                    kind="heading",
                    line=i,
                    # Half-open span so the floor's source slice is that line.
                    end_line=i + 1,
                    loc=1,
                    depth=len(heading.group(1)) - 1,
                )
            )
        else:
            prose += 1

    # Markdown prose documents itself; fenced code does not have to.
    comments = len(_HTML_COMMENT.findall(source))
    return ParseResult(
        language="markdown",
        logical_loc=logical,
        floors=floors,
        comment_lines=comments,
        doc_lines=prose + comments,
        confidence="high",
    )


# --------------------------------------------------------------------------
# HTML
# --------------------------------------------------------------------------

_HEADING = re.compile(r"<h([1-6])\b[^>]*>(.*?)</h\1\s*>", re.IGNORECASE | re.DOTALL)
_SCRIPT = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)
_STYLE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^>]+>")
_ATTR_SRC = re.compile(r"\bsrc\s*=", re.IGNORECASE)


def _text_of(html: str) -> str:
    text = _TAG.sub(" ", html)
    text = (
        text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    )
    return " ".join(text.split())


def parse_html(source: str) -> ParseResult:
    lines = source.splitlines()
    blank = sum(1 for line in lines if not line.strip())
    logical = len(lines) - blank

    floors: list[Floor] = []

    # Headings -> floors.
    for match in _HEADING.finditer(source):
        name = _text_of(match.group(2))
        if not name:
            continue
        line_no = source.count("\n", 0, match.start()) + 1
        floors.append(
            Floor(
                name=_shorten(name, 80),
                kind="heading",
                line=line_no,
                end_line=line_no + 1,
                loc=1,
                depth=int(match.group(1)) - 1,
            )
        )

    # Inline scripts -> functions and classes, via the shared brace scanner.
    script_lines = 0
    for match in _SCRIPT.finditer(source):
        attrs, body = match.group(1), match.group(2)
        if _ATTR_SRC.search(attrs or "") or not body.strip():
            continue
        offset = source.count("\n", 0, match.start(2))
        script_lines += body.count("\n") + 1
        try:
            from .brace import parse_brace

            inner = parse_brace(body, "javascript")
        except Exception:
            continue
        for floor in inner.floors:
            floors.append(
                Floor(
                    name=floor.name,
                    kind=floor.kind,
                    doc=floor.doc,
                    line=floor.line + offset,
                    end_line=floor.end_line + offset,
                    loc=floor.loc,
                    depth=floor.depth,
                )
            )

    # Hide script/style bodies so they are not mistaken for page prose.
    without_code = _STYLE.sub(" ", source)
    without_code = _SCRIPT.sub(" ", without_code)
    # Remove comments, then count lines that still carry visible text.
    body_no_comments = _HTML_COMMENT.sub(" ", without_code)
    prose_lines = 0
    for line in body_no_comments.splitlines():
        if _text_of(line):
            prose_lines += 1

    comment_count = len(_HTML_COMMENT.findall(source))

    if not floors and logical:
        floors.append(
            Floor(name="page", kind="section", line=1, end_line=len(lines), loc=logical, depth=0)
        )

    return ParseResult(
        language="html",
        logical_loc=logical,
        floors=floors,
        comment_lines=comment_count,
        doc_lines=prose_lines + comment_count,
        confidence="high" if logical else "medium",
    )
