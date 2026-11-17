#!/usr/bin/env node
/**
 * Code Cleaner: read-only post-refactor reference gate (Node >= 18).
 *
 * Exit codes: 0 PASS · 1 FAIL (a check was violated) · 2 usage or I/O error ·
 * 3 INCOMPLETE (nothing violated in the files that were searched, but some part
 * of the requested scope could not be searched, so a PASS would be unearned).
 *
 * The gate never prints file contents, only paths and line numbers, so running
 * it over a repository cannot leak secrets that happen to sit near a match.
 */
import {
  VERSION, BINARY_EXTENSIONS, ensureRoot, walk, readTextFile, normalizeRelative, overlaps,
  existsNoFollow, clean, parseFlags, isMainModule, pathMatcher,
} from './lib.mjs';

const MAX_ERRORS_SHOWN = 50;
const MAX_ERRORS_JSON = 200;

export { pathMatcher };

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const USAGE = `Code Cleaner — read-only replacement gate
Usage: node gate.mjs --root PATH [--old LITERAL] [--require LITERAL]
                     [--forbid-path RELATIVE_PATH] [--scope RELATIVE_PATH]
                     [--exclude RELATIVE_PATH] [--word] [--ignore-case]
                     [--max-bytes N] [--json]

Repeat --old, --require, --forbid-path, --scope and --exclude as needed.
  --old          text that must be ABSENT from every searched file
  --require      text that must appear in at least one searched file
  --forbid-path  file or folder that must not exist
  --word         match whole identifiers (saveTask does not match saveTaskV2)
  --ignore-case  case-insensitive matching
  --scope        only search under this path or glob (a path must exist); --exclude skips a path or glob
                 Globs: *.md  **/*.lock  android/**  (no slash = match the file name at any depth)
Use --old=VALUE when VALUE starts with a dash. Quote globs so the shell does not expand them.

Exit codes: 0 PASS, 1 FAIL, 2 usage/IO error, 3 INCOMPLETE (could not search everything).
All text files are searched (any extension). Checks are textual: a PASS does NOT
prove runtime correctness or the absence of dynamically built names.
Examples:
  node gate.mjs --root . --old saveTaskV2 --require saveTask --word
  node gate.mjs --root . --old oldHandler --exclude docs/
`;

const FLAGS = {
  '--root': { key: 'root', kind: 'value' },
  '--old': { key: 'old', kind: 'multi' },
  '--require': { key: 'require', kind: 'multi' },
  '--forbid-path': { key: 'forbidPaths', kind: 'multi' },
  '--scope': { key: 'scopes', kind: 'multi' },
  '--exclude': { key: 'excludes', kind: 'multi' },
  '--max-bytes': { key: 'maxBytes', kind: 'value' },
  '--word': { key: 'word', kind: 'bool' },
  '--ignore-case': { key: 'ignoreCase', kind: 'bool' },
  '--json': { key: 'json', kind: 'bool' },
};

export function getOptions(args) {
  const options = parseFlags(args, FLAGS, {
    root: '.', old: [], require: [], forbidPaths: [], scopes: [], excludes: [],
    maxBytes: String(DEFAULT_MAX_BYTES), word: false, ignoreCase: false, json: false,
  });
  if (!options) return null;
  options.maxBytes = Number(options.maxBytes);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('--max-bytes must be a positive integer');
  if (!options.old.length && !options.require.length && !options.forbidPaths.length) {
    throw new Error('Specify at least one --old, --require or --forbid-path check');
  }
  return options;
}

/** Whole-word matching only constrains sides of the literal that begin/end with an identifier character. */
function buildMatcher(literal, { word, ignoreCase }) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const before = word && /^[\w$]/.test(literal) ? '(?<![\\w$])' : '';
  const after = word && /[\w$]$/.test(literal) ? '(?![\\w$])' : '';
  return new RegExp(`${before}${escaped}${after}`, ignoreCase ? 'gi' : 'g');
}

function lineNumbers(text, matcher, limit = 15) {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lines = [];
  let total = 0;
  matcher.lastIndex = 0;
  for (const match of text.matchAll(matcher)) {
    total++;
    if (lines.length >= limit) continue;
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= match.index) low = mid; else high = mid - 1;
    }
    const line = low + 1;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return { lines, total };
}

export function gate(options) {
  const root = ensureRoot(options.root);
  const excludes = (options.excludes || []).map(pathMatcher);
  const scopes = (options.scopes || []).map(pathMatcher);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const flags = { word: Boolean(options.word), ignoreCase: Boolean(options.ignoreCase) };

  // A scope that does not exist is almost certainly a typo, and searching nothing must never read as PASS.
  for (const scope of scopes) {
    if (!scope.glob && scope.prefix !== '' && !existsNoFollow(root, scope.prefix)) throw new Error(`--scope does not exist inside the root: ${scope.text}`);
  }

  const walked = walk(root);
  const excludeHits = new Map(excludes.map(rule => [rule, 0]));
  const candidates = walked.files.filter(file => {
    const excluded = excludes.filter(rule => rule.test(file.relative));
    excluded.forEach(rule => excludeHits.set(rule, excludeHits.get(rule) + 1));
    return !excluded.length && (!scopes.length || scopes.some(scope => scope.test(file.relative)));
  });
  const scopeHits = new Map(scopes.map(scope => [scope, 0]));
  const forbidden = (options.old || []).map(literal => ({ literal, matcher: buildMatcher(literal, flags) }));
  const required = (options.require || []).map(literal => ({ literal, matcher: buildMatcher(literal, flags), found: false }));

  const errors = [];
  const skippedLarge = [];
  const unreadable = [];
  let binarySkipped = 0;
  let searchedFiles = 0;
  for (const file of candidates) {
    for (const scope of scopes) if (scope.test(file.relative)) scopeHits.set(scope, scopeHits.get(scope) + 1);
    if (BINARY_EXTENSIONS.has(file.ext)) { binarySkipped++; continue; }
    const result = readTextFile(file, maxBytes);
    if (result.status === 'large') { skippedLarge.push(file.relative); continue; }
    if (result.status === 'unreadable') { unreadable.push(file.relative); continue; }
    if (result.status === 'binary') { binarySkipped++; continue; }
    searchedFiles++;
    for (const check of forbidden) {
      const { lines, total } = lineNumbers(result.text, check.matcher);
      if (total) errors.push({ kind: 'obsolete literal remains', text: check.literal, path: file.relative, lines, occurrences: total });
    }
    for (const check of required) {
      if (check.found) continue;
      check.matcher.lastIndex = 0;
      check.found = check.matcher.test(result.text);
    }
  }
  for (const raw of options.forbidPaths || []) {
    const relative = normalizeRelative(raw);
    if (relative === '') throw new Error('--forbid-path cannot be the repository root');
    if (existsNoFollow(root, relative)) errors.push({ kind: 'forbidden path still exists', path: relative });
  }

  // Coverage problems: nothing violated, but the answer would be incomplete.
  const incomplete = [];
  const needsSearch = forbidden.length > 0 || required.length > 0;
  if (needsSearch && searchedFiles === 0) incomplete.push({ kind: 'no files were searched' });
  for (const [scope, count] of scopeHits) if (count === 0) incomplete.push({ kind: 'scope matched no files', path: scope.text });
  if (skippedLarge.length) incomplete.push({ kind: `files larger than ${maxBytes} bytes were not searched (raise --max-bytes, or --exclude generated files such as lockfiles)`, paths: skippedLarge.slice(0, 20), total: skippedLarge.length });
  if (unreadable.length) incomplete.push({ kind: 'unreadable files were not searched', paths: unreadable.slice(0, 20), total: unreadable.length });
  const relevantDirs = walked.unreadableDirs.filter(dir => !scopes.length || scopes.some(scope => scope.glob || scope.test(dir) || overlaps(scope.prefix, dir)));
  if (relevantDirs.length) incomplete.push({ kind: 'unreadable directories were not searched', paths: relevantDirs.slice(0, 20), total: relevantDirs.length });

  // "Not found" only proves absence when everything was searched; otherwise it is a coverage gap, not a failure.
  for (const check of required.filter(entry => !entry.found)) {
    if (incomplete.length) incomplete.push({ kind: 'required literal not found, but the search was incomplete', path: check.literal });
    else errors.push({ kind: 'required literal missing', text: check.literal });
  }

  const status = errors.length ? 'FAIL' : incomplete.length ? 'INCOMPLETE' : 'PASS';
  return {
    tool: 'Code Cleaner replacement gate', version: VERSION, root, status, searchedFiles,
    checks: { forbiddenLiterals: options.old || [], requiredLiterals: options.require || [], forbiddenPaths: options.forbidPaths || [], scopes: scopes.map(r => r.text), excludes: excludes.map(r => r.text), ...flags },
    coverage: {
      skippedDirectories: walked.skippedDirs, symlinksNotFollowed: walked.symlinks, binaryFilesSkipped: binarySkipped, incomplete,
      unmatchedExcludes: [...excludeHits].filter(([, hits]) => hits === 0).map(([rule]) => rule.text),
    },
    errorTotal: errors.length,
    errors: errors.slice(0, MAX_ERRORS_JSON),
    warning: 'A PASS only confirms these exact textual checks; it does not establish functional correctness, absence of dynamically built names, or full cleanup.',
  };
}

function render(result) {
  const out = [`${result.status}: searched ${result.searchedFiles} files. ${result.errorTotal} violation(s).`];
  for (const error of result.errors.slice(0, MAX_ERRORS_SHOWN)) {
    const subject = clean(error.text ?? error.path);
    const where = error.path && error.text ? ` in ${clean(error.path)}` : '';
    const lines = error.lines ? ` at lines ${error.lines.join(', ')}${error.occurrences > error.lines.length ? ` (${error.occurrences} occurrences)` : ''}` : '';
    out.push(`- ${error.kind}: ${subject}${where}${lines}`);
  }
  if (result.errorTotal > MAX_ERRORS_SHOWN) out.push(`- … ${result.errorTotal - MAX_ERRORS_SHOWN} more violations not shown (use --json, or narrow with --scope).`);
  for (const gap of result.coverage.incomplete) {
    const list = gap.paths ? ` ${gap.paths.map(p => clean(p)).join(', ')}${gap.total > gap.paths.length ? ` (+${gap.total - gap.paths.length} more)` : ''}` : gap.path ? ` ${clean(gap.path)}` : '';
    out.push(`- not covered: ${gap.kind}${list}`);
  }
  if (result.coverage.unmatchedExcludes.length) out.push(`Note: --exclude matched no files (typo?): ${result.coverage.unmatchedExcludes.map(p => clean(p)).join(', ')}.`);
  if (result.coverage.skippedDirectories.length) out.push(`Skipped directories: ${result.coverage.skippedDirectories.map(d => clean(d)).join(', ')}.`);
  out.push(result.warning);
  return `${out.join('\n')}\n`;
}

function main() {
  try {
    const opts = getOptions(process.argv.slice(2));
    if (!opts) { process.stdout.write(USAGE); return; }
    const result = gate(opts);
    process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
    process.exitCode = { PASS: 0, FAIL: 1, INCOMPLETE: 3 }[result.status];
  } catch (error) {
    process.stderr.write(`Code Cleaner gate error: ${clean(error.message, 500)}\n`);
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) main();
