"""Parser tests: the numbers that decide building shape."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from support import TINY_TEMPLATE

from analyzer.parse import parse_file, parse_text
from analyzer.parse.tabular import count_json_rows


class PythonParserTests(unittest.TestCase):
    def test_floors_and_documentation(self):
        path = os.path.join(TINY_TEMPLATE, "alpha", "main.py")
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        result = parse_text("main.py", source)

        names = [f.name for f in result.floors]
        self.assertEqual(names, ["documented", "Alpha", "described", "bare"])
        kinds = [f.kind for f in result.floors]
        self.assertEqual(kinds, ["function", "class", "method", "method"])
        depths = [f.depth for f in result.floors]
        self.assertEqual(depths, [0, 0, 1, 1])

        self.assertTrue(result.floors[0].doc.startswith("Add two numbers"))
        self.assertEqual(result.floors[3].doc, "")
        # Comments and docstrings are documentation, not code height.
        self.assertGreater(result.doc_lines, 0)
        self.assertLess(result.logical_loc, result.physical_lines)

    def test_broken_python_does_not_raise(self):
        result = parse_text("broken.py", "def f(:\n  pass\n")
        self.assertEqual(result.confidence, "low")
        self.assertTrue(result.parse_error)
        self.assertGreater(result.logical_loc, 0)

    def test_hash_inside_a_string_is_not_a_comment(self):
        source = 'x = "# not a comment"\n# real comment\ny = 1\n'
        result = parse_text("s.py", source)
        self.assertEqual(result.comment_lines, 1)


class NotebookTests(unittest.TestCase):
    def test_cell_source_sets_height_and_outputs_are_ignored(self):
        path = os.path.join(TINY_TEMPLATE, "beta", "notebook.ipynb")
        result = parse_file(path, "notebook.ipynb", False)

        self.assertEqual(result.language, "notebook")
        # Two code cells: one with a comment and a def, one with a call.
        self.assertGreaterEqual(result.logical_loc, 3)
        # A markdown cell plus a comment are documentation.
        self.assertGreater(result.doc_lines, 0)
        kinds = [f.kind for f in result.floors]
        self.assertIn("cell", kinds)
        self.assertIn("heading", kinds)

    def test_bloated_outputs_do_not_inflate_height(self):
        """The whole point: notebook bytes are a lie."""
        # A notebook with a 400 KB base64 PNG output and three lines of code.
        blob = "A" * 400_000
        doc = {
            "cells": [
                {
                    "cell_type": "code",
                    "metadata": {},
                    "outputs": [{"data": {"image/png": blob}, "output_type": "display_data"}],
                    "source": ["import os\n", "\n", "print(os.getcwd())\n"],
                }
            ],
            "metadata": {},
            "nbformat": 4,
        }
        with tempfile.NamedTemporaryFile("w", suffix=".ipynb", delete=False) as fh:
            json.dump(doc, fh)
            path = fh.name
        self.addCleanup(os.unlink, path)

        size = os.path.getsize(path)
        result = parse_file(path, "bloated.ipynb", False)
        self.assertGreater(size, 400_000)
        self.assertEqual(result.logical_loc, 2)  # `print(...)` and the import
        self.assertLess(result.logical_loc, size / 10_000)


class MarkupTests(unittest.TestCase):
    def test_markdown_heading_tree(self):
        source = "# Title\n\ntext\n\n## Sub\n\n```\ncode not prose\n```\n"
        result = parse_text("a.md", source)
        self.assertEqual([f.name for f in result.floors], ["Title", "Sub"])
        self.assertEqual([f.depth for f in result.floors], [0, 1])
        # Fenced code is not counted as prose documentation.
        self.assertGreater(result.doc_lines, 0)

    def test_html_headings_and_inline_script_functions(self):
        path = os.path.join(TINY_TEMPLATE, "delta gamma", "thing.js")
        with open(path, encoding="utf-8") as fh:
            script = fh.read()

        html = (
            "<html><body>\n<h1>Lesson</h1>\n<h2>Part</h2>\n"
            "<script>\n" + script + "\n</script>\n"
            "<p>Some visible prose.</p>\n</body></html>\n"
        )
        result = parse_text("lesson.html", html)
        self.assertEqual(result.language, "html")
        names = [f.name for f in result.floors]
        self.assertIn("Lesson", names)
        self.assertIn("Part", names)
        # IIFE-wrapped functions must still be found.
        self.assertIn("makeThing", names)
        self.assertIn("describe", names)


class BraceScannerTests(unittest.TestCase):
    def test_iife_functions_are_floors(self):
        path = os.path.join(TINY_TEMPLATE, "delta gamma", "thing.js")
        result = parse_file(path, "thing.js", False)
        names = [f.name for f in result.floors]
        self.assertIn("makeThing", names)
        self.assertIn("describe", names)
        self.assertEqual(result.confidence, "medium")

    def test_declarations_inside_strings_are_not_floors(self):
        source = 'const s = "function notReal() {}";\nfunction real() {}\n'
        result = parse_text("x.js", source)
        names = [f.name for f in result.floors]
        self.assertEqual(names, ["real"])

    def test_comment_only_lines_are_counted(self):
        source = "// one\n// two\nfunction f() {}\n"
        result = parse_text("x.js", source)
        self.assertEqual(result.comment_lines, 2)
        self.assertEqual(result.logical_loc, 1)


class DataParserTests(unittest.TestCase):
    def test_csv_rows_exclude_the_header(self):
        path = os.path.join(TINY_TEMPLATE, "beta", "data", "counts.csv")
        result = parse_file(path, "counts.csv", False)
        self.assertEqual(result.rows, 4)
        self.assertEqual(result.floors, [])

    def test_single_line_json_uses_the_table_length(self):
        """A 494-byte JSON with zero newlines is a 50-row silo, not a 1-row one."""
        path = os.path.join(TINY_TEMPLATE, "huge.json")
        with open(path, "rb") as fh:
            self.assertEqual(fh.read().count(b"\n"), 0)
        result = parse_file(path, "huge.json", False)
        self.assertEqual(result.rows, 50)

    def test_json_row_proxy_prefers_the_largest_array(self):
        cases = {
            '{"a": 1, "b": 2}': 2,
            '{"t": [1, 2, 3], "big": [{"x": 1}, {"x": 2}, {"x": 3}, {"x": 4}]}': 4,
            "[1, 2, 3, 4, 5]": 5,
            '{"empty": []}': 1,
        }
        for body, expected in cases.items():
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
                fh.write(body)
                path = fh.name
            self.addCleanup(os.unlink, path)
            largest, keys, _ = count_json_rows(path)
            self.assertEqual(max(largest, keys), expected, body)


class GenericFallbackTests(unittest.TestCase):
    def test_unknown_language_degrades_gracefully(self):
        result = parse_text("data.weird", "# comment\nvalue\nvalue2\n")
        self.assertEqual(result.confidence, "low")
        self.assertEqual(result.logical_loc, 3)
        self.assertEqual(result.comment_lines, 1)


if __name__ == "__main__":
    unittest.main()
