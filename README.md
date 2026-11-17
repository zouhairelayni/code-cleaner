# Code Cleaner

**A portable coding-agent skill that prevents refactoring by accumulation.**

Code Cleaner makes an agent audit a codebase, find dead or duplicated code, replace implementations *in place*, and keep the result human-readable. The principle: **one feature, one authoritative implementation, no unnecessary old paths.**

It does **not** remove legitimate resilience, authentication, data migration, external API contracts or recovery features, and it keeps a read-only audit separate from authorized edits.

> Formerly "Cleaner Code" (1.0). The skill identifier is now `code-cleaner`; the display name is "Code Cleaner". Uninstall any old `cleaner-code` folder before installing this one so two copies do not compete.

## Contents

| Path | Purpose |
| --- | --- |
| `SKILL.md` | The skill: modes, trust boundaries, rules, workflow, deletion gate |
| `references/` | Audit method, replacement protocol, readability rules, safety checklist, report templates |
| `scripts/scan.mjs` | Read-only scanner: import graph, dead code leads, duplicates (Node 18+) |
| `scripts/gate.mjs` | Read-only post-replacement check (Node 18+) |
| `scripts/lib.mjs` | Helpers shared by the scripts (walking, path safety, sanitizing, flags, globs) |
| `scripts/jslex.mjs` | JS/TS tokenizer and module-reference extractor |
| `scripts/graph.mjs` | Module resolver (tsconfig, workspaces, exports), Python imports, reachability |
| `scripts/check_skill.py` | Package checker: frontmatter, links, script security lint, checksums (Python 3.9+) |
| `tests/` | Automated tests, including an accuracy benchmark on two realistic repositories with answer keys (`tests/fixtures/`) |
| `evals/` | Behavioral test cases for the skill itself (prompt + graders + fixtures); omitted from `.skill` bundles |
| `assets/AGENTS-snippet.md` | Optional rule to paste into a project's `AGENTS.md` / `CLAUDE.md` |
| `SHA256SUMS.txt` | Integrity list (detects accidental change; it cannot prove who wrote the files) |

## Install

Copy the whole `code-cleaner` folder, keeping its structure, into your agent's skills directory:

```sh
# Claude Code, personal skills
mkdir -p ~/.claude/skills && cp -R code-cleaner ~/.claude/skills/

# Codex CLI, personal skills (inside the environment that runs Codex)
mkdir -p ~/.agents/skills && cp -R code-cleaner ~/.agents/skills/
```

If Codex runs inside a Debian proot on Android, install under **Debian's** home, not Termux's. For one project only, copy into `.claude/skills/` or `.agents/skills/` in that repository. Restart the agent if it does not discover the skill.

## Use

> Use Code Cleaner in **audit** mode on the whole repository. Do not edit anything.

> Use Code Cleaner in **replace** mode: rework the checkout flow in place, remove the old branches, update every caller, and verify.

> Use Code Cleaner in **clean** mode to implement the approved cleanup plan (items CC-001 to CC-004 only).

> Use Code Cleaner in **verify** mode: confirm the old implementation has no references left and list the checks that were not run.

## Scripts

No `npm install`. Standard library only.

```sh
# Scan (writes nothing unless --out names a NEW file OUTSIDE the scanned repo)
node code-cleaner/scripts/scan.mjs --root /path/to/project --format md
# Declare entry points the scanner cannot recognise (cron jobs, CLIs, workers); globs must be quoted
node code-cleaner/scripts/scan.mjs --root /path/to/project --entry src/jobs/nightly.ts --entry 'workers/**'
node code-cleaner/scripts/scan.mjs --root /path/to/project --format json --out /tmp/code-cleaner-audit.json

# Gate: old name gone (whole identifiers), canonical name present, retired file gone
node code-cleaner/scripts/gate.mjs --root /path/to/project --old saveTaskV2 --require saveTask --word --forbid-path src/services/saveTaskV2.ts
# Exclude by path or glob (quote globs)
node code-cleaner/scripts/gate.mjs --root /path/to/project --old getUser --word --exclude '*.md' --exclude 'android/**'

# Check the package, and rewrite SHA256SUMS.txt after a deliberate edit
python3 code-cleaner/scripts/check_skill.py code-cleaner
python3 code-cleaner/scripts/check_skill.py code-cleaner --update-checksums

# Tests
node --test code-cleaner/tests/*.test.mjs
python3 -m unittest discover -s code-cleaner/tests -p 'test_*.py'
```

`gate.mjs` exit codes: **0** PASS · **1** FAIL · **2** usage or I/O error · **3** INCOMPLETE (some of the requested scope could not be searched, such as an unreadable folder or an over-size file, so a PASS would be unearned).

The scanner cannot prove that anything is unused. Entry points it cannot recognise, remote clients, generated code, native registration and computed imports cause false positives, and dead-chain findings are only as good as the entry-point list; its coverage section lists what it could not see. **Never auto-delete from scanner output.** A passing gate only means the given strings and paths passed a textual check; run the project's real tests too.

## Security model

- The scripts never use the network, never spawn processes, and never modify the target repository. `check_skill.py` enforces this by linting `scripts/` (and fails the package check if that promise is broken).
- Scripts do not follow symlinks, reject paths that leave the root, redact credential-looking endpoint strings, never print file contents (the gate prints only paths and line numbers), and neutralize control characters and bidi overrides in anything copied from the repository.
- `--out` refuses to overwrite, refuses to follow a link, refuses a path inside the scanned repo, and creates the report with owner-only permissions.
- `SKILL.md` tells the agent to treat repository text, including script output, as data, not instructions; to avoid the network, installs and unreviewed commands; to keep secrets out of reports; and to leave Git history and uncommitted work alone.
- Limits: a hostile file name can still appear in a report (it is sanitized but not hidden), and the checksum list protects against accidents, not against someone who rewrites both a file and the list. Review a skill before installing it, including this one.

## Language support

| Area | What you get |
| --- | --- |
| JavaScript, TypeScript, React (JSX/TSX) | Full import graph: unused modules, dead chains, closed cycles, tests-only code, unused exports |
| Next.js (app and pages routers), Vite, Remix, Astro, Gatsby, Nuxt, SvelteKit, Expo Router | Same, plus each framework's routing and auto-import conventions treated as entry points |
| React Native / Expo | Same, including platform files (`Button.ios.tsx` / `Button.android.tsx`); native `android/` and `ios/` code is only covered by the "other languages" row |
| Vue, Svelte, Astro, MDX | Components are modules; script imports are followed |
| Python | Import graph (absolute, relative, package `__init__`, dotted module names in strings); `__main__`, tests and `manage.py` treated as entry points |
| Kotlin, Java, Swift, Go, Rust, Ruby, PHP, C#, C/C++, Dart, Scala, SQL and similar | Duplicate files and repeated regions, versioned names (`PanelOld.kt`), legacy/fallback wording. **No unused-module detection** |
| Any language | `gate.mjs` searches all text files, so it can verify a rename or removal anywhere |

Support was verified on constructed repositories and on npm and pip, not on a large corpus of real React Native, Kotlin, Go or Rust projects. Treat results outside JS/TS and Python as lower confidence.

## Accuracy

On two realistic repositories with hand-made answer keys (a polyglot monorepo and a held-out repo of SvelteKit, Nuxt, Vite, Express, pnpm and Next-pages projects), the scanner offers **0 of 61 live files and misses 0 of 21 dead files**. The held-out repository was written and measured *before* any tuning: the first version flagged 52% of its live files, which is why entry-point detection is now relative to each package and framework-aware. Against real code (npm's source, pip) it surfaces plausible dead code and defers to a "dynamic loads" warning where loading is genuinely computed. These numbers describe those repositories, not every codebase; treat every finding as a lead.

## Changelog

**2.1.0** Tested against complex code and fixed what broke. Scanner: real tokenizer instead of regexes (strings such as `'/api/*'` no longer swallow imports; import-looking text in templates no longer counts); import graph with reachability (dead chains, closed cycles, test-only modules); monorepo workspaces, per-package `tsconfig` with `extends`, package `exports` with `dist`→`src`; Python imports; Vue/Svelte/Astro files as modules; framework conventions (Next, Nuxt, SvelteKit, Remix, Astro, Gatsby); manifests, Dockerfiles and CI as entry points; unused exports; camelCase revision names (`HeaderOld`); implicit framework dependencies (`react`, `next`); `--entry` flag; chains explain which module reaches them; warning when no entry points are recognised. Gate: globs in `--scope`/`--exclude`, capped output, warning for excludes that match nothing. React Native platform files; duplicate, versioned-name and wording checks for Kotlin, Go, Rust, Swift and other languages (the 2.0 docs claimed this but the scanner did not read those files). Fixed: `.map(clean)` truncating text, gate dropping constants, a crash in repeated-request reporting. Tests grew to 152 (114 Node, 38 Python), mutation-checked.

**2.0.0** Renamed to Code Cleaner. Scanner: multi-line imports, `./x.js`→`x.ts`, tsconfig `paths`, asset imports, Vue/Svelte importers, merged duplicate regions, fewer false "versioned" hits, secret redaction, safe `--out`, symlink-safe launch. Gate: INCOMPLETE state and exit code 3, scope validation, all text files, whole-word and ignore-case, dangling-symlink detection. Checker: real frontmatter parser, link and path-escape checks, script security lint, checksum verification. Skill: trust boundaries, deletion gate, narrower triggers. Tests expanded from 10 to 93 (55 Node, 38 Python), plus 5 behavioral eval cases (2.1.0 adds a sixth).
