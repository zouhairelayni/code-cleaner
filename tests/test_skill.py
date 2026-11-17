"""Tests for scripts/check_skill.py (standard library unittest)."""
import contextlib
import io
import pathlib
import shutil
import sys
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACKAGE / "scripts"))
import check_skill as cs  # noqa: E402

GOOD_BODY = "# Demo\n\nDo the thing. See [ref](references/REF.md) and `scripts/tool.py`.\n"


def make_skill(parent, name="demo-skill", front=None, body=GOOD_BODY, files=None, ref=True):
    """Build a minimal valid skill folder; files maps relative path -> text."""
    root = pathlib.Path(parent) / name
    root.mkdir(parents=True)
    front = front if front is not None else f"name: {name}\ndescription: Review code for demo purposes.\n"
    (root / "SKILL.md").write_text(f"---\n{front}---\n\n{body}", encoding="utf-8")
    contents = dict(files or {})
    if ref:
        contents.setdefault("references/REF.md", "# Ref\n")
        contents.setdefault("scripts/tool.py", "print('ok')\n")
    for relative, text in contents.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    return root


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def errors(self, root, checksums=False):
        return cs.check_skill_full(root, checksums=checksums).errors

    def assertHasError(self, errors, fragment):
        self.assertTrue(any(fragment in e for e in errors), f"expected {fragment!r} in {errors}")


class BundledPackage(Base):
    def copy_package(self):
        destination = self.tmp / "code-cleaner"
        shutil.copytree(PACKAGE, destination, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
        return destination

    def test_bundled_skill_is_valid_wherever_it_is_unpacked(self):
        # The checker requires folder name == skill name, so test from a correctly named copy.
        findings = cs.check_skill_full(self.copy_package())
        self.assertEqual(findings.errors, [])

    def test_bundled_skill_name_and_display_name(self):
        text = (PACKAGE / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("name: code-cleaner\n", text)
        self.assertIn('display-name: Code Cleaner', text)

    def test_no_stale_old_name_anywhere(self):
        for path in PACKAGE.rglob("*"):
            if path.is_file() and path.suffix in {".md", ".mjs", ".py", ".txt", ".yaml", ".sh"} and "__pycache__" not in path.parts:
                if path.name in {"test_skill.py", "README.md"}:  # the README records the former name on purpose
                    continue
                text = path.read_text(encoding="utf-8")
                self.assertNotIn("Cleaner Code", text, path)
                self.assertNotIn("cleaner-code", text, path)

    def test_description_is_within_limit_and_describes_when_to_use(self):
        findings = cs.Findings()
        data, _ = cs.parse_frontmatter((PACKAGE / "SKILL.md").read_text(encoding="utf-8"), findings)
        self.assertEqual(findings.errors, [])
        self.assertLessEqual(len(data["description"]), 1024)
        self.assertIn("Use whenever", data["description"])
        self.assertEqual(data["metadata"]["version"], "2.1.0")


class Frontmatter(Base):
    def test_valid_minimal_skill(self):
        self.assertEqual(self.errors(make_skill(self.tmp)), [])

    def test_missing_description(self):
        root = make_skill(self.tmp, front="name: demo-skill\n")
        self.assertHasError(self.errors(root), "Description")

    def test_name_rules(self):
        for bad in ["Demo-Skill", "demo--skill", "-demo", "demo_skill", "my-claude-helper"]:
            root = make_skill(self.tmp / bad.replace("/", "_"), name=bad, front=f"name: {bad}\ndescription: x\n")
            self.assertTrue(self.errors(root), bad)

    def test_folder_name_must_match(self):
        root = make_skill(self.tmp, front="name: other-name\ndescription: x\n")
        self.assertHasError(self.errors(root), "must equal skill name")

    def test_crlf_and_bom_are_accepted(self):
        root = make_skill(self.tmp)
        text = (root / "SKILL.md").read_text(encoding="utf-8").replace("\n", "\r\n")
        (root / "SKILL.md").write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
        self.assertEqual(self.errors(root), [])

    def test_block_scalar_description(self):
        root = make_skill(self.tmp, front="name: demo-skill\ndescription: >\n  Review code.\n  Use often.\n")
        findings = cs.Findings()
        data, _ = cs.parse_frontmatter((root / "SKILL.md").read_text(encoding="utf-8"), findings)
        self.assertEqual(data["description"], "Review code. Use often.")
        self.assertEqual(findings.errors, [])

    def test_unquoted_colon_is_caught(self):
        root = make_skill(self.tmp, front="name: demo-skill\ndescription: Use for: reviews\n")
        self.assertHasError(self.errors(root), "unquoted ': '")

    def test_quoted_colon_is_fine(self):
        root = make_skill(self.tmp, front='name: demo-skill\ndescription: "Use for: reviews"\n')
        self.assertEqual(self.errors(root), [])

    def test_unclosed_quote_duplicate_key_and_garbage(self):
        self.assertHasError(self.errors(make_skill(self.tmp / "a", front='name: demo-skill\ndescription: "oops\n')), "never closes")
        self.assertHasError(self.errors(make_skill(self.tmp / "b", front="name: demo-skill\ndescription: x\ndescription: y\n")), "Duplicate")
        self.assertHasError(self.errors(make_skill(self.tmp / "c", front="name: demo-skill\ndescription: x\n???\n")), "Unparseable")

    def test_limits_and_tags(self):
        long = "x" * 1025
        self.assertHasError(self.errors(make_skill(self.tmp / "a", front=f"name: demo-skill\ndescription: {long}\n")), "Description must contain")
        self.assertHasError(self.errors(make_skill(self.tmp / "b", front="name: demo-skill\ndescription: Use <b>this</b>\n")), "XML/HTML")
        compat = "y" * 501
        self.assertHasError(self.errors(make_skill(self.tmp / "c", front=f"name: demo-skill\ndescription: x\ncompatibility: {compat}\n")), "compatibility")

    def test_missing_or_unclosed_frontmatter(self):
        root = make_skill(self.tmp / "a")
        (root / "SKILL.md").write_text("# no frontmatter\n", encoding="utf-8")
        self.assertHasError(self.errors(root), "must begin")
        (root / "SKILL.md").write_text("---\nname: demo-skill\n", encoding="utf-8")
        self.assertHasError(self.errors(root), "closing")
        empty = self.tmp / "empty-dir" / "demo-skill"
        empty.mkdir(parents=True)
        self.assertHasError(self.errors(empty), "Missing SKILL.md")

    def test_unknown_key_is_a_warning_not_an_error(self):
        root = make_skill(self.tmp, front="name: demo-skill\ndescription: x\nextra-key: 1\n")
        findings = cs.check_skill_full(root, checksums=False)
        self.assertEqual(findings.errors, [])
        self.assertTrue(any("extra-key" in w for w in findings.warnings))

    def test_nested_metadata_map(self):
        root = make_skill(self.tmp, front='name: demo-skill\ndescription: x\nmetadata:\n  version: "1.0"\n  owner: me\n')
        findings = cs.Findings()
        data, _ = cs.parse_frontmatter((root / "SKILL.md").read_text(encoding="utf-8"), findings)
        self.assertEqual(data["metadata"], {"version": "1.0", "owner": "me"})


class Links(Base):
    def test_broken_link_and_missing_path_mention(self):
        root = make_skill(self.tmp, body="[gone](references/NOPE.md)\nRun `scripts/missing.py`.\n")
        errors = self.errors(root)
        self.assertHasError(errors, "broken link: references/NOPE.md")
        self.assertHasError(errors, "does not exist: scripts/missing.py")

    def test_link_escaping_the_package_is_rejected_even_if_target_exists(self):
        (self.tmp / "outside.md").write_text("secret", encoding="utf-8")
        root = make_skill(self.tmp / "pkg", body="[x](../outside.md) and [y](references/../../outside.md)\n")
        self.assertHasError(self.errors(root), "escapes the package")

    def test_external_anchor_and_code_block_links_are_ignored(self):
        body = "[web](https://example.com) [mail](mailto:a@b.c) [top](#top)\n```\n[fake](references/NOPE.md)\n```\n"
        self.assertEqual(self.errors(make_skill(self.tmp, body=body)), [])

    def test_links_inside_references_are_checked(self):
        root = make_skill(self.tmp, files={"references/REF.md": "[bad](OTHER.md)\n"})
        self.assertHasError(self.errors(root), "references/REF.md: broken link")


class Structure(Base):
    def test_symlink_is_rejected(self):
        root = make_skill(self.tmp)
        (root / "link.md").symlink_to(self.tmp)
        self.assertHasError(self.errors(root), "Symlink not allowed")

    def test_oversized_file(self):
        root = make_skill(self.tmp, files={"references/BIG.md": "x" * 1_100_000})
        self.assertHasError(self.errors(root), "larger than")


class ScriptSecurityLint(Base):
    def lint(self, name, source):
        return self.errors(make_skill(self.tmp, files={f"scripts/{name}": source}))

    def test_python_network_process_and_eval_are_rejected(self):
        errors = self.lint("bad.py", "import subprocess\nimport urllib.request\nfrom socket import socket\neval('1')\nexec('x')\n__import__('os').system('x')\nimport os\nos.system('ls')\n")
        for fragment in ["subprocess", "urllib.request", "socket", "calls eval", "calls exec", "os.system"]:
            self.assertHasError(errors, fragment)

    def test_python_writes_and_deletes_are_rejected(self):
        errors = self.lint("bad.py", "import os, shutil, pathlib\nshutil.rmtree('x')\nos.remove('x')\npathlib.Path('p').unlink()\npathlib.Path('p').write_text('x')\nopen('f', 'w')\nopen('f', mode='r')\n")
        for fragment in ["shutil.rmtree", "os.remove", "unlink", "write_text", "opens a file for writing"]:
            self.assertHasError(errors, fragment)

    def test_python_str_replace_and_re_compile_are_not_false_positives(self):
        self.assertEqual(self.lint("ok.py", "import re\nx = 'a'.replace('a', 'b')\nitems = [1]\nitems.remove(1)\nre.compile('x')\nprint(x)\n"), [])

    def test_python_read_only_script_is_fine(self):
        self.assertEqual(self.lint("ok.py", "import pathlib\nprint(pathlib.Path('.').read_text())\n"), [])

    def test_javascript_network_process_eval_and_writes_are_rejected(self):
        source = (
            "import { exec } from 'node:child_process';\nimport http from 'node:http';\n"
            "await fetch('https://example.com');\neval('1');\nnew Function('x');\n"
            "fs.rmSync('x');\nfs.writeFileSync('x', 'y');\nawait import(name);\nfs.mkdirSync('d');\n"
        )
        errors = self.lint("bad.mjs", source)
        for fragment in ["spawns processes", "network or code-evaluation", "uses the network", "evaluates strings", "modifies the file system", "writes files with writeFileSync", "dynamically computed module"]:
            self.assertHasError(errors, fragment)

    def test_javascript_comments_do_not_trigger_the_lint(self):
        source = "// never uses child_process or fetch(\n/* eval( is banned */\nexport const x = 1;\n"
        self.assertEqual(self.lint("ok.mjs", source), [])

    def test_javascript_literal_dynamic_import_is_fine(self):
        self.assertEqual(self.lint("ok.mjs", "const m = await import('./lib.mjs');\n"), [])

    def test_bundled_scripts_pass_the_lint_and_the_lint_would_catch_a_regression(self):
        findings = cs.Findings()
        cs.check_scripts(PACKAGE, findings)
        self.assertEqual(findings.errors, [])
        root = self.tmp / "code-cleaner"
        shutil.copytree(PACKAGE, root, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
        scan = root / "scripts" / "scan.mjs"
        scan.write_text(scan.read_text(encoding="utf-8") + "\nimport('node:https');\nfs.rmSync('/tmp/x');\n", encoding="utf-8")
        regressions = cs.Findings()
        cs.check_scripts(root, regressions)
        self.assertHasError(regressions.errors, "scan.mjs")

    def test_shell_scripts_get_a_warning(self):
        root = make_skill(self.tmp, files={"scripts/run.sh": "echo hi\n"})
        self.assertTrue(any("run.sh" in w for w in cs.check_skill_full(root, checksums=False).warnings))


class Checksums(Base):
    def test_missing_list_is_a_warning(self):
        findings = cs.check_skill_full(make_skill(self.tmp))
        self.assertEqual(findings.errors, [])
        self.assertTrue(any("SHA256SUMS.txt is missing" in w for w in findings.warnings))

    def test_write_then_verify_then_detect_tampering_and_additions(self):
        root = make_skill(self.tmp)
        cs.write_checksums(root)
        self.assertEqual(self.errors(root, checksums=True), [])
        (root / "references" / "REF.md").write_text("# changed\n", encoding="utf-8")
        self.assertHasError(self.errors(root, checksums=True), "changed since")
        cs.write_checksums(root)
        (root / "references" / "NEW.md").write_text("# new\n", encoding="utf-8")
        self.assertHasError(self.errors(root, checksums=True), "does not list references/NEW.md")
        (root / "references" / "NEW.md").unlink()
        (root / "references" / "REF.md").unlink()
        self.assertHasError(self.errors(root, checksums=True), "does not exist")

    def test_checksum_entry_cannot_point_outside(self):
        root = make_skill(self.tmp)
        cs.write_checksums(root)
        with (root / "SHA256SUMS.txt").open("a", encoding="utf-8") as handle:
            handle.write("0" * 64 + "  ../escape.txt\nnot a checksum line\n")
        errors = self.errors(root, checksums=True)
        self.assertHasError(errors, "escapes the package")
        self.assertHasError(errors, "malformed")

    def test_evals_are_not_part_of_the_integrity_list(self):
        root = make_skill(self.tmp, files={"evals/case/prompt.md": "x"})
        cs.write_checksums(root)
        self.assertNotIn("evals/", (root / "SHA256SUMS.txt").read_text(encoding="utf-8"))
        shutil.rmtree(root / "evals")  # what an installable bundle without evals looks like
        self.assertEqual(self.errors(root, checksums=True), [])

    def test_pycache_is_ignored(self):
        root = make_skill(self.tmp, files={"scripts/__pycache__/x.pyc": "junk"})
        cs.write_checksums(root)
        self.assertNotIn("__pycache__", (root / "SHA256SUMS.txt").read_text(encoding="utf-8"))


class CommandLine(Base):
    def run_main(self, *args):
        argv = sys.argv
        sys.argv = ["check_skill.py", *map(str, args)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return cs.main()
        finally:
            sys.argv = argv

    def test_exit_codes(self):
        root = make_skill(self.tmp)
        self.assertEqual(self.run_main(root, "--no-checksums"), 0)
        self.assertEqual(self.run_main(root, "--update-checksums"), 0)
        (root / "references" / "REF.md").write_text("changed", encoding="utf-8")
        self.assertEqual(self.run_main(root), 1)
        self.assertEqual(self.run_main(self.tmp / "nope"), 2)


if __name__ == "__main__":
    unittest.main()
