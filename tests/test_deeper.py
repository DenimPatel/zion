"""The deeper architect's signals: defects, trend, hubs, import depth, debt,
hidden coupling, abstractness, coordination cost and clone twins.

Like `test_insights.py`, each test builds a small repository in which the
signal has exactly one right answer.
"""

from __future__ import annotations

import os
import subprocess
import unittest

from support import TempRepoCase, git_commit, read_json

from analyzer.clones import fingerprint
from analyzer.gitmeta import is_fix
from analyzer.parse import parse_text, scan_debt


def _write(repo: str, rel: str, body: str) -> None:
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path) or repo, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)


def _init(repo: str) -> None:
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)


def _body(name: str, lines: int = 12) -> str:
    """A distinct function with enough logical lines to have a size."""
    out = [f"def {name}(value):"]
    for i in range(lines):
        out.append(f"    value = value + {i}  # step {i}")
    out.append("    return value")
    return "\n".join(out) + "\n"


class ParserSignalTests(unittest.TestCase):
    def test_fix_subjects(self):
        for subject in ("fix: crash on empty input", "Fix typo", "hotfix for login", "Revert \"x\"",
                        "closes #12", "bug in parser", "fix(api): wrong code"):
            self.assertTrue(is_fix(subject), subject)
        for subject in ("add prefix option", "debug logging", "refactor layout", "suffix handling"):
            self.assertFalse(is_fix(subject), subject)

    def test_debt_markers_only_in_comments(self):
        self.assertEqual([m for _, m, _ in scan_debt("# TODO: split this\nx = 1  # FIXME(ana): later\n")],
                         ["TODO", "FIXME"])
        self.assertEqual(scan_debt("todo_list = []\n# mentions TODO/FIXME in prose\n"), [])
        result = parse_text("mod.py", "def f():\n    # HACK: until the API is fixed\n    return 1\n")
        self.assertEqual([(line, marker) for line, marker, _ in result.debt], [(2, "HACK")])

    def test_python_abstractness_is_read_off_the_ast(self):
        source = (
            "from abc import ABC, abstractmethod\n"
            "from typing import Protocol\n\n"
            "class Port(ABC):\n    @abstractmethod\n    def send(self): ...\n\n"
            "class Reader(Protocol):\n    def read(self): ...\n\n"
            "class Mixin:\n    @abstractmethod\n    def hook(self): ...\n\n"
            "class Concrete(Port):\n    def send(self):\n        return 1\n"
        )
        result = parse_text("ports.py", source)
        self.assertEqual((result.classes, result.abstract_classes), (4, 3))

    def test_brace_abstractness(self):
        source = (
            "public interface Store { void put(); }\n"
            "public abstract class Base implements Store { }\n"
            "public class Impl extends Base { public void put() {} }\n"
        )
        result = parse_text("Store.java", source)
        self.assertEqual((result.classes, result.abstract_classes), (3, 2))

    def test_fingerprints_survive_renaming_and_reformatting(self):
        original = _body("compute", 20)
        renamed = original.replace("compute", "calculate").replace("value", "total").replace("    ", "  ")
        other = "\n".join(f"print('line {i}', {i} * 3)" for i in range(30)) + "\n"
        a, b, c = fingerprint(original), fingerprint(renamed), fingerprint(other)
        self.assertTrue(a)
        self.assertEqual(set(a), set(b))
        self.assertFalse(set(a) & set(c))


class ContractTests(unittest.TestCase):
    def test_viewer_flag_bits_mirror_emit(self):
        """`facets.js::FLAG_BITS` is kept by hand; it must match emit.py's FLAG_* exactly."""
        import re

        from analyzer import emit

        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "viewer", "js", "facets.js"), encoding="utf-8") as fh:
            text = fh.read()
        block = text[text.index("const FLAG_BITS = {") : text.index("};", text.index("const FLAG_BITS = {"))]
        viewer = {int(bit) for bit in re.findall(r"1 << (\d+)", block)}
        python = {
            value.bit_length() - 1 for name, value in vars(emit).items() if name.startswith("FLAG_") and isinstance(value, int)
        }
        self.assertEqual(viewer, python)


class DeeperSignalTests(TempRepoCase):
    def _history_repo(self) -> str:
        """Six months of history: a fix-prone file, a rising one, a cooling one."""
        repo = self.scratch()
        _init(repo)
        names = ["buggy", "rising", "cooling", "steady", "quiet1", "quiet2", "quiet3", "quiet4", "quiet5", "quiet6"]
        for name in names:
            _write(repo, f"src/{name}.py", _body(name))
        git_commit(repo, "initial import", date="2024-01-01T10:00:00+00:00")
        month = ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06", "2024-07"]

        def touch(rel: str, message: str, date: str, author: str = "Ada Lovelace", email: str = "ada@example.com"):
            with open(os.path.join(repo, rel), "a", encoding="utf-8") as fh:
                fh.write(f"# {message} {date}\n")
            git_commit(repo, message, author=author, email=email, date=date)

        # cooling: busy early, silent in the last quarter.
        for day in ("05", "10", "15", "20"):
            touch("src/cooling.py", "tune cooling", f"{month[1]}-{day}T10:00:00+00:00")
            touch("src/cooling.py", "tune cooling more", f"{month[2]}-{day}T10:00:00+00:00")
        # rising: quiet early, busy in the last quarter.
        for m in month[4:7]:
            for day in ("03", "12", "21"):
                touch("src/rising.py", "extend rising", f"{m}-{day}T10:00:00+00:00", author="Grace Hopper",
                      email="grace@example.com")
        # buggy: mostly fixes.
        for i, m in enumerate(month[1:7]):
            touch("src/buggy.py", "fix: off by one" if i % 3 else "add buggy feature", f"{m}-08T10:00:00+00:00")
        # steady: a little every month.
        for m in month[1:7]:
            touch("src/steady.py", "update steady", f"{m}-25T10:00:00+00:00")
        # Everyone else gets two ordinary commits so the fix share is a minority.
        for name in names[4:]:
            touch(f"src/{name}.py", "document", f"{month[3]}-02T10:00:00+00:00")
            touch(f"src/{name}.py", "polish", f"{month[3]}-04T10:00:00+00:00")
        return repo

    def test_defects_and_trend(self):
        analysis, _layout, result = self.build_city(self._history_repo(), district_depth=1)
        by = {f.rel: f for f in analysis.files}
        self.assertTrue(analysis.flags.defects)
        self.assertTrue(by["src/buggy.py"].is_defect)
        self.assertFalse(by["src/steady.py"].is_defect)
        self.assertGreater(by["src/buggy.py"].fix_ratio, 0.5)
        self.assertTrue(analysis.flags.trend)
        self.assertEqual(by["src/rising.py"].trend, 1)
        self.assertEqual(by["src/cooling.py"].trend, -1)
        self.assertEqual(by["src/steady.py"].trend, 0)
        # Index columns carry them, appended at the end.
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        columns = manifest["indexColumns"]
        self.assertEqual(columns[-4:], ["fixes", "trend", "debt", "depth"])
        rows = read_json(os.path.join(result.out_dir, "index.json"))
        path_col = columns.index("id")
        self.assertTrue(any(row[columns.index("trend")] == 1 for row in rows))
        self.assertTrue(rows[0][path_col] >= 0)

    def test_hubs_and_import_depth(self):
        repo = self.scratch()
        _init(repo)
        # a chain leaf <- mid <- top, and a hub imported by six and importing three.
        _write(repo, "lib/__init__.py", "")
        for name in ("a", "b", "c"):
            _write(repo, f"lib/{name}.py", _body(name))
        _write(repo, "lib/hub.py", "from lib import a\nfrom lib import b\nfrom lib import c\n\n" + _body("hub"))
        for i in range(6):
            _write(repo, f"app/user{i}.py", "from lib import hub\n\n" + _body(f"user{i}"))
        _write(repo, "app/__init__.py", "")
        _write(repo, "chain/__init__.py", "")
        _write(repo, "chain/leaf.py", _body("leaf"))
        _write(repo, "chain/mid.py", "from chain import leaf\n\n" + _body("mid"))
        _write(repo, "chain/top.py", "from chain import mid\n\n" + _body("top"))
        git_commit(repo, "initial")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        by = {f.rel: f for f in analysis.files}
        self.assertTrue(by["lib/hub.py"].is_hub)
        self.assertFalse(by["lib/a.py"].is_hub)
        self.assertEqual(by["chain/top.py"].import_depth, 2)
        self.assertEqual(by["chain/mid.py"].import_depth, 1)
        self.assertEqual(by["chain/leaf.py"].import_depth, 0)
        self.assertEqual(by["app/user0.py"].import_depth, 2)

    def test_hidden_coupling_excludes_import_pairs(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "api/__init__.py", "")
        _write(repo, "api/schema.py", _body("schema"))
        _write(repo, "api/handler.py", "from api import schema\n\n" + _body("handler"))
        _write(repo, "web/__init__.py", "")
        _write(repo, "web/form.py", "from web import util\n\n" + _body("form"))
        _write(repo, "web/util.py", _body("util"))
        _write(repo, "web/client.py", "from api import schema\n\n" + _body("client"))
        git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
        for i in range(4):
            for rel in ("api/schema.py", "web/form.py", "web/client.py"):
                with open(os.path.join(repo, rel), "a", encoding="utf-8") as fh:
                    fh.write(f"# change {i}\n")
            git_commit(repo, f"change the wire format {i}", date=f"2024-02-0{i + 1}T10:00:00+00:00")
        analysis, _layout, result = self.build_city(repo, district_depth=1)
        by = {f.rel: f for f in analysis.files}
        # schema <-> form changed together, no import: hidden.
        self.assertIn("web/form.py", [o for o, _ in by["api/schema.py"].hidden_coupling])
        # schema <-> client changed together too, but client imports schema: not hidden.
        self.assertNotIn("web/client.py", [o for o, _ in by["api/schema.py"].hidden_coupling])
        self.assertTrue(analysis.flags.hidden_coupling)
        # Emitted as building ids, never paths.
        chunk_ids = {}
        manifest = read_json(os.path.join(result.out_dir, "city.json"))
        for district in manifest["districts"]:
            for building in read_json(os.path.join(result.out_dir, district["chunk"]))["buildings"]:
                chunk_ids[building["id"]] = building
        partners = [b["hiddenCoupling"] for b in chunk_ids.values() if b["hiddenCoupling"]]
        self.assertTrue(partners)
        self.assertTrue(all(isinstance(p[0], int) for pair in partners for p in pair))

    def test_abstractness_and_zone_of_pain(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "core/__init__.py", "")
        for name in ("user", "order", "item"):
            _write(repo, f"core/{name}.py", f"class {name.title()}:\n    def get(self):\n        return 1\n")
        _write(repo, "ports/__init__.py", "")
        _write(repo, "ports/api.py", "from abc import ABC, abstractmethod\n\n" + "".join(
            f"class P{i}(ABC):\n    @abstractmethod\n    def run(self): ...\n\n" for i in range(3)
        ) + "from core import user\n")
        for i in range(3):
            _write(repo, f"app/use{i}.py", "from core import user, order, item\n\ndef go():\n    return user.User()\n")
        _write(repo, "app/__init__.py", "")
        git_commit(repo, "initial")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        core = analysis.architecture.districts["core"]
        ports = analysis.architecture.districts["ports"]
        self.assertEqual(core.abstractness, 0.0)
        self.assertEqual(core.instability, 0.0)
        self.assertEqual(core.zone, "pain")
        self.assertEqual(ports.abstractness, 1.0)
        self.assertTrue(analysis.flags.abstractness)

    def test_clone_twins(self):
        repo = self.scratch()
        _init(repo)
        original = (
            "import json\n\n\n"
            "def compute(records, limit=10):\n"
            "    totals = {}\n"
            "    for record in records:\n"
            "        key = record.get('owner') or 'nobody'\n"
            "        totals[key] = totals.get(key, 0) + record['size']\n"
            "    ranked = sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))\n"
            "    if len(ranked) > limit:\n"
            "        ranked = ranked[:limit]\n"
            "    lines = []\n"
            "    for name, size in ranked:\n"
            "        share = size / max(1, sum(totals.values()))\n"
            "        lines.append(f'{name}: {size} ({share:.0%})')\n"
            "    with open('report.json', 'w') as handle:\n"
            "        json.dump({'lines': lines, 'count': len(ranked)}, handle)\n"
            "    while lines and not lines[-1]:\n"
            "        lines.pop()\n"
            "    try:\n"
            "        return '\\n'.join(lines)\n"
            "    except TypeError as error:\n"
            "        raise ValueError(str(error)) from error\n"
        )
        _write(repo, "a/one.py", original)
        _write(repo, "b/two.py", original.replace("compute", "calculate").replace("totals", "sums"))
        _write(repo, "c/three.py", _body("other", 3) + "\n".join(f"x{i} = '{i}' * {i}" for i in range(40)) + "\n")
        # Tests are repetitive by design and never twinned.
        _write(repo, "tests/test_one.py", original)
        git_commit(repo, "initial")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        by = {f.rel: f for f in analysis.files}
        self.assertEqual([o for o, _ in by["a/one.py"].clone_of], ["b/two.py"])
        self.assertTrue(by["b/two.py"].is_clone)
        self.assertFalse(by["c/three.py"].is_clone)
        self.assertFalse(by["tests/test_one.py"].is_clone)
        self.assertTrue(analysis.flags.clones)
        # The scratch fingerprints do not survive into the analysis.
        self.assertTrue(all(not f.fingerprints for f in analysis.files))

    def test_many_cooks(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "shared/common.py", _body("common"))
        _write(repo, "solo/own.py", _body("own"))
        git_commit(repo, "initial", date="2024-01-01T10:00:00+00:00")
        people = [(f"Dev {i}", f"dev{i}@example.com") for i in range(7)]
        for i, (name, email) in enumerate(people):
            with open(os.path.join(repo, "shared/common.py"), "a", encoding="utf-8") as fh:
                fh.write("\n".join(f"# note {i} {j}" for j in range(5)) + f"\nvalue_{i} = {i}\n")
            git_commit(repo, "tweak", author=name, email=email, date=f"2024-03-{10 + i}T10:00:00+00:00")
        analysis, _layout, _result = self.build_city(repo, district_depth=1)
        shared = analysis.architecture.districts["shared"]
        solo = analysis.architecture.districts["solo"]
        self.assertGreaterEqual(shared.recent_authors, 6)
        self.assertTrue(shared.many_cooks)
        self.assertFalse(solo.many_cooks)
        self.assertTrue(analysis.flags.teams)

    def test_encrypted_build_leaks_no_debt_text(self):
        repo = self.scratch()
        _init(repo)
        _write(repo, "pkg/secret.py", "def f():\n    # TODO: rotate the zebra-crossing-key\n    return 1\n")
        _write(repo, "pkg/other.py", _body("other"))
        git_commit(repo, "initial")
        out = os.path.join(self._tmp, "enc")
        self.build_city(repo, district_depth=1, out_dir=out, encrypt=True, passphrase="correct horse")
        for base, _dirs, names in os.walk(out):
            for name in names:
                if name.endswith((".json", ".bin")):
                    with open(os.path.join(base, name), "rb") as fh:
                        self.assertNotIn(b"zebra-crossing", fh.read(), name)


if __name__ == "__main__":
    unittest.main()
