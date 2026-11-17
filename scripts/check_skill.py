#!/usr/bin/env python3
"""Check that a skill package is well formed and keeps its safety promises.

Standard library only (Python 3.9+). This is a local lint, NOT the official
Agent Skills validator. It checks:

* frontmatter: name, description, length limits, YAML pitfalls, unknown keys
* structure: folder name, links and path mentions that must resolve inside the
  package, no symlinks, no oversized or binary files outside assets/
* security: scripts/ must not use the network, spawn processes, evaluate
  strings as code, or modify files beyond an explicit allowlist
* integrity: SHA256SUMS.txt matches the files (integrity against accidents, not
  authenticity: whoever can edit a file can also edit the checksum list)

Exit code 0 = no errors (warnings may be printed), 1 = errors, 2 = usage error.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import pathlib
import re
import sys

ALLOWED_KEYS = {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}
MAX_NAME, MAX_DESCRIPTION, MAX_COMPATIBILITY = 64, 1024, 500
MAX_FILE_BYTES, MAX_TOTAL_BYTES = 1_000_000, 5_000_000
CHECKSUM_FILE = "SHA256SUMS.txt"
IGNORED_PARTS = {"__pycache__", "node_modules", ".git", ".DS_Store"}
IGNORED_PREFIXES = ("evals/results/",)
LINK_PATTERN = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)\)")
PATH_MENTION = re.compile(r"(?<![\w/.-])((?:scripts|references|assets|examples|tests|evals)/[A-Za-z0-9_./-]*[A-Za-z0-9_/])")

# Scripts may write only where the documented behaviour needs it.
ALLOWED_PYTHON_WRITES = {"scripts/check_skill.py": {"write_text"}}
ALLOWED_JS_WRITES = {"scripts/scan.mjs": {"writeFileSync"}}

BANNED_PYTHON_MODULES = {
    "subprocess", "socket", "ssl", "urllib", "http", "ftplib", "smtplib", "telnetlib", "requests",
    "httpx", "aiohttp", "ctypes", "multiprocessing", "pty", "webbrowser", "xmlrpc", "asyncio",
}
BANNED_PYTHON_CALLS = {"eval", "exec", "compile", "__import__", "os.system", "os.popen", "os.spawn", "os.exec"}
# Method names that only exist on file-system objects, plus module functions that share a name with str/list methods.
DESTRUCTIVE_PYTHON_METHODS = {"unlink", "rmtree", "rmdir", "rename", "chmod", "chown", "truncate", "symlink", "symlink_to", "hardlink_to", "mkdir", "makedirs", "touch"}
DESTRUCTIVE_PYTHON_FUNCTIONS = {"os.remove", "os.replace", "os.rename", "os.removedirs", "shutil.move", "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree"}
WRITING_PYTHON_CALLS = {"write_text", "write_bytes"}

BANNED_JS_PATTERNS = [
    (r"child_process", "spawns processes"),
    (r"node:(?:http|https|http2|net|tls|dgram|dns|vm|worker_threads|cluster|inspector|repl)\b", "uses the network or code-evaluation modules"),
    (r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b\s*\(", "uses the network"),
    (r"\beval\s*\(", "evaluates strings as code"),
    (r"\bnew\s+Function\s*\(", "evaluates strings as code"),
    (r"process\.(?:binding|dlopen)\b", "loads native code"),
    (r"\bimport\s*\(\s*[^'\"\s)]", "loads a dynamically computed module"),
    (r"\b(?:rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|appendFileSync|truncateSync|chmodSync|chownSync|symlinkSync|linkSync|mkdirSync|cpSync)\b", "modifies the file system"),
    (r"\bfs\.promises\b|\bfsp\.", "uses asynchronous file-system writes that this lint cannot audit"),
]
JS_WRITE_CALLS = re.compile(r"\b(writeFileSync|writeFile|createWriteStream|openSync)\b")


class Findings:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []


# ---------------------------------------------------------------- frontmatter
def _unquote(value: str, key: str, findings: Findings) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        return inner.replace("''", "'") if value[0] == "'" else re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), inner)
    if value[:1] in "\"'":
        findings.errors.append(f"Frontmatter '{key}' starts a quote that never closes")
    elif ": " in value or " #" in value or value.endswith(":"):
        findings.errors.append(f"Frontmatter '{key}' has an unquoted ': ' or ' #' that YAML will mis-parse; wrap the value in quotes")
    return value


def parse_frontmatter(text: str, findings: Findings) -> tuple[dict, str] | None:
    """Parse the small YAML subset skills use: scalars, quoted scalars, block scalars, one nested map."""
    text = text.lstrip("\ufeff").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        findings.errors.append("SKILL.md must begin with a YAML frontmatter line '---'")
        return None
    end = re.search(r"^---[ \t]*$", text[4:], re.MULTILINE)
    if not end:
        findings.errors.append("YAML frontmatter lacks a closing '---' line")
        return None
    block, body = text[4:4 + end.start()], text[4 + end.end():]
    data: dict = {}
    lines = block.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z][\w-]*):(?:\s+(.*))?$", line)
        if not match or line.startswith((" ", "\t")):
            findings.errors.append(f"Unparseable frontmatter line: {line.strip()[:60]!r}")
            continue
        key, raw = match.group(1), (match.group(2) or "").strip()
        if key in data:
            findings.errors.append(f"Duplicate frontmatter key: {key}")
        nested: list[str] = []
        while index < len(lines) and (lines[index].startswith((" ", "\t")) or not lines[index].strip()):
            nested.append(lines[index])
            index += 1
        if re.fullmatch(r"[>|][+-]?", raw):
            parts = [part.strip() for part in nested if part.strip()]
            data[key] = (" " if raw[0] == ">" else "\n").join(parts)
        elif raw == "" and nested:
            mapping: dict[str, str] = {}
            for entry in nested:
                if not entry.strip():
                    continue
                sub = re.match(r"^\s+([A-Za-z][\w-]*):\s*(.*)$", entry)
                if sub:
                    mapping[sub.group(1)] = _unquote(sub.group(2).strip(), f"{key}.{sub.group(1)}", findings)
                else:
                    findings.errors.append(f"Frontmatter '{key}' must be a flat map of key: value pairs")
                    break
            data[key] = mapping
        else:
            data[key] = _unquote(raw, key, findings) if raw else ""
    return data, body


def check_frontmatter(root: pathlib.Path, findings: Findings) -> str | None:
    skill_file = root / "SKILL.md"
    if not skill_file.is_file():
        findings.errors.append(f"Missing SKILL.md in {root}")
        return None
    try:
        text = skill_file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        findings.errors.append("SKILL.md is not valid UTF-8")
        return None
    parsed = parse_frontmatter(text, findings)
    if parsed is None:
        return None
    data, body = parsed
    name, description = data.get("name", ""), data.get("description", "")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > MAX_NAME:
        findings.errors.append("Invalid name: lowercase letters, digits and single hyphens only (max 64)")
    elif re.search(r"anthropic|claude", name):
        findings.errors.append("Invalid name: must not contain 'anthropic' or 'claude'")
    if root.name != name:
        findings.errors.append(f"Folder name ({root.name}) must equal skill name ({name})")
    if not description or len(description) > MAX_DESCRIPTION:
        findings.errors.append(f"Description must contain 1-{MAX_DESCRIPTION} characters")
    elif re.search(r"</?[A-Za-z][^>]*>", description):
        findings.errors.append("Description must not contain XML/HTML tags")
    compatibility = data.get("compatibility", "")
    if isinstance(compatibility, str) and len(compatibility) > MAX_COMPATIBILITY:
        findings.errors.append(f"compatibility exceeds {MAX_COMPATIBILITY} characters")
    metadata = data.get("metadata", {})
    if metadata and not isinstance(metadata, dict):
        findings.errors.append("metadata must be a map of string values")
    for key in data:
        if key not in ALLOWED_KEYS:
            findings.warnings.append(f"Unknown frontmatter key '{key}' (allowed by the open spec: {', '.join(sorted(ALLOWED_KEYS))})")
    if not body.strip():
        findings.errors.append("SKILL.md has no instruction body")
    if len(text.splitlines()) > 500:
        findings.warnings.append("SKILL.md exceeds the recommended 500 lines; move detail into references/")
    return text


# ------------------------------------------------------------------ structure
def package_files(root: pathlib.Path) -> list[pathlib.Path]:
    found = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if IGNORED_PARTS.intersection(path.relative_to(root).parts) or relative.startswith(IGNORED_PREFIXES) or path.suffix == ".pyc":
            continue
        found.append(path)
    return found


def check_structure(root: pathlib.Path, findings: Findings) -> None:
    total = 0
    for path in package_files(root):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            findings.errors.append(f"Symlink not allowed in a skill package: {relative}")
            continue
        if not path.is_file():
            continue
        size = path.stat().st_size
        total += size
        if size > MAX_FILE_BYTES:
            findings.errors.append(f"File larger than {MAX_FILE_BYTES} bytes: {relative}")
        if not relative.startswith("assets/"):
            try:
                path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                findings.warnings.append(f"Non-text file outside assets/: {relative}")
    if total > MAX_TOTAL_BYTES:
        findings.errors.append(f"Package is larger than {MAX_TOTAL_BYTES} bytes")


def check_links(root: pathlib.Path, findings: Findings) -> None:
    """Every markdown link and every mention of a bundled path must point at a real file inside the package."""
    resolved_root = root.resolve()
    for path in package_files(root):
        if path.suffix != ".md" or not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root).as_posix()
        if relative.startswith("evals/"):
            continue  # eval prompts may deliberately mention paths that exist only in their fixtures
        text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.DOTALL)
        for target in LINK_PATTERN.findall(text):
            if re.match(r"^(?:[a-z][a-z0-9+.-]*:|#)", target, re.IGNORECASE):
                continue
            clean = target.split("#", 1)[0]
            destination = (path.parent / clean).resolve()
            if resolved_root != destination and resolved_root not in destination.parents:
                findings.errors.append(f"{relative}: link escapes the package: {target}")
            elif not destination.exists():
                findings.errors.append(f"{relative}: broken link: {target}")
        if "/" in relative:
            continue  # prose in references/ may use "a/b" as shorthand; only top-level docs must mention real paths
        for mention in PATH_MENTION.findall(text):
            if any(char in mention for char in "<>*$"):
                continue
            destination = (root / mention).resolve()
            if resolved_root not in destination.parents and destination != resolved_root:
                findings.errors.append(f"{relative}: path mention escapes the package: {mention}")
            elif not destination.exists():
                findings.errors.append(f"{relative}: mentions a file that does not exist: {mention}")


# ------------------------------------------------------------------- security
def _call_name(node: ast.AST) -> str:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    # A call, literal or subscript receiver (Path(x).unlink()) is marked "?" so method names still count as attribute calls.
    parts.append(node.id if isinstance(node, ast.Name) else "?")
    return ".".join(reversed(parts)) if len(parts) > 1 or isinstance(node, ast.Name) else parts[0]


def lint_python(path: pathlib.Path, relative: str, findings: Findings) -> None:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
    except SyntaxError as error:
        findings.errors.append(f"{relative}: syntax error: {error.msg} (line {error.lineno})")
        return
    allowed = ALLOWED_PYTHON_WRITES.get(relative, set())
    for node in ast.walk(tree):
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules = [node.module]
        for module in modules:
            if module.split(".")[0] in BANNED_PYTHON_MODULES:
                findings.errors.append(f"{relative}:{node.lineno}: imports '{module}' (network, process or native-code access is not allowed in bundled scripts)")
        if isinstance(node, ast.Call):
            name = _call_name(node.func)
            leaf = name.rsplit(".", 1)[-1]
            if name in BANNED_PYTHON_CALLS or any(name.startswith(prefix) for prefix in ("os.spawn", "os.exec")):
                findings.errors.append(f"{relative}:{node.lineno}: calls {name}()")
            elif name in DESTRUCTIVE_PYTHON_FUNCTIONS or (leaf in DESTRUCTIVE_PYTHON_METHODS and "." in name):
                findings.errors.append(f"{relative}:{node.lineno}: calls {name}(), which modifies the file system")
            elif leaf in WRITING_PYTHON_CALLS and leaf not in allowed:
                findings.errors.append(f"{relative}:{node.lineno}: calls {name}(), which writes files (not in this script's allowlist)")
            elif name == "open" and len(node.args) > 1 and isinstance(node.args[1], ast.Constant) and any(c in str(node.args[1].value) for c in "wax+"):
                findings.errors.append(f"{relative}:{node.lineno}: opens a file for writing")


def strip_js_comments(source: str) -> str:
    return re.sub(r"(?s:/\*.*?\*/)|(?m:^[ \t]*//.*$)", "", source)


def lint_javascript(path: pathlib.Path, relative: str, findings: Findings) -> None:
    source = strip_js_comments(path.read_text(encoding="utf-8"))
    for pattern, reason in BANNED_JS_PATTERNS:
        for match in re.finditer(pattern, source):
            line = source.count("\n", 0, match.start()) + 1
            findings.errors.append(f"{relative}: {reason} ({match.group(0).strip()!r}, near line {line})")
    allowed = ALLOWED_JS_WRITES.get(relative, set())
    for match in JS_WRITE_CALLS.finditer(source):
        if match.group(1) not in allowed:
            line = source.count("\n", 0, match.start()) + 1
            findings.errors.append(f"{relative}: writes files with {match.group(1)} (not in this script's allowlist, near line {line})")


def check_scripts(root: pathlib.Path, findings: Findings) -> None:
    """Scripts are the only executable surface of a skill, so they carry the "read-only, no network" promise."""
    scripts = root / "scripts"
    if not scripts.is_dir():
        return
    for path in sorted(scripts.rglob("*")):
        if path.is_symlink() or not path.is_file() or IGNORED_PARTS.intersection(path.parts) or path.suffix == ".pyc":
            continue
        relative = path.relative_to(root).as_posix()
        if path.suffix == ".py":
            lint_python(path, relative, findings)
        elif path.suffix in {".mjs", ".js", ".cjs"}:
            lint_javascript(path, relative, findings)
        elif path.suffix in {".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd"}:
            findings.warnings.append(f"{relative}: shell scripts are not covered by the security lint; review by hand")


# ------------------------------------------------------------------ integrity
def checksum_targets(root: pathlib.Path) -> list[str]:
    # evals/ is test data that some packagers leave out of installable bundles, so it is not part of the integrity list.
    return [p.relative_to(root).as_posix() for p in package_files(root)
            if p.is_file() and not p.is_symlink() and p.name != CHECKSUM_FILE and not p.relative_to(root).as_posix().startswith("evals/")]


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_checksums(root: pathlib.Path) -> None:
    lines = [f"{digest(root / rel)}  {rel}" for rel in checksum_targets(root)]
    (root / CHECKSUM_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")


def check_checksums(root: pathlib.Path, findings: Findings) -> None:
    listing = root / CHECKSUM_FILE
    if not listing.is_file():
        findings.warnings.append(f"{CHECKSUM_FILE} is missing (run with --update-checksums to create it)")
        return
    expected: dict[str, str] = {}
    for number, line in enumerate(listing.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64})  (\S.*)", line)
        if not match:
            findings.errors.append(f"{CHECKSUM_FILE}:{number}: malformed line")
            continue
        expected[match.group(2)] = match.group(1)
    actual = set(checksum_targets(root))
    for relative, want in sorted(expected.items()):
        target = (root / relative).resolve()
        if root.resolve() not in target.parents:
            findings.errors.append(f"{CHECKSUM_FILE}: entry escapes the package: {relative}")
        elif relative not in actual:
            findings.errors.append(f"{CHECKSUM_FILE}: lists a file that does not exist: {relative}")
        elif digest(root / relative) != want:
            findings.errors.append(f"{CHECKSUM_FILE}: {relative} changed since the checksums were written")
    for relative in sorted(actual - set(expected)):
        findings.errors.append(f"{CHECKSUM_FILE}: does not list {relative}")


# ----------------------------------------------------------------------- API
def check_skill_full(root: pathlib.Path, *, checksums: bool = True) -> Findings:
    findings = Findings()
    check_frontmatter(root, findings)
    if (root / "SKILL.md").is_file():
        check_structure(root, findings)
        check_links(root, findings)
        check_scripts(root, findings)
        if checksums:
            check_checksums(root, findings)
    return findings


def check_skill(root: pathlib.Path) -> list[str]:
    """Errors only, without the checksum comparison (kept for simple callers and tests)."""
    return check_skill_full(root, checksums=False).errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", nargs="?", default=str(pathlib.Path(__file__).resolve().parent.parent), help="skill folder (default: this skill)")
    parser.add_argument("--update-checksums", action="store_true", help="rewrite SHA256SUMS.txt after a deliberate change, then check")
    parser.add_argument("--no-checksums", action="store_true", help="skip the SHA256SUMS.txt comparison")
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    if not root.is_dir():
        print(f"FAIL: not a directory: {root}")
        return 2
    if args.update_checksums:
        write_checksums(root)
    findings = check_skill_full(root, checksums=not args.no_checksums)
    for warning in findings.warnings:
        print("WARN:", warning)
    if findings.errors:
        for error in findings.errors:
            print("FAIL:", error)
        return 1
    print(f"PASS: {root.name} — structure, links, script safety and checksums verified (local lint, not the official validator)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
