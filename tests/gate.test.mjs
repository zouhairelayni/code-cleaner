import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gate, getOptions, pathMatcher } from '../scripts/gate.mjs';
import { inProject, snapshot, runScript, isRoot } from './helpers.mjs';

/** A small replaced feature: canonical code in src/, history in docs/. */
function fixture(run) {
  return inProject(({ root, put }) => {
    put('src/feature.ts', 'export function canonicalHandler() {}\n');
    put('docs/history.md', 'Old handler was obsoleteHandler.\n');
    return run({ root, put });
  });
}

const opts = (root, extra = {}) => ({
  root, old: ['obsoleteHandler'], require: ['canonicalHandler'], forbidPaths: ['src/obsolete.ts'], scopes: [], excludes: ['docs'], ...extra,
});

test('gate passes for a replaced implementation when old references are absent', () => fixture(({ root }) => {
  const result = gate(opts(root));
  assert.equal(result.status, 'PASS');
  assert.equal(result.searchedFiles, 1);
}));

test('gate reports old references with lines and forbids retired files', () => fixture(({ root, put }) => {
  fs.appendFileSync(path.join(root, 'src', 'feature.ts'), '// obsoleteHandler\n');
  put('src/obsolete.ts', 'export const old = true;\n');
  const result = gate(opts(root));
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(error => error.kind === 'obsolete literal remains' && error.lines.includes(2)));
  assert.ok(result.errors.some(error => error.kind === 'forbidden path still exists'));
}));

test('gate reports a missing required symbol', () => fixture(({ root }) => {
  const result = gate(opts(root, { require: ['doesNotExist'] }));
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(error => error.kind === 'required literal missing'));
}));

test('gate is read-only', () => fixture(({ root }) => {
  const before = snapshot(root);
  gate(opts(root));
  assert.deepEqual(snapshot(root), before);
}));

// ---- regression tests for false PASS results in the 1.0 gate ----

test('a mistyped or escaping scope is an error, never a PASS over zero files', () => fixture(({ root }) => {
  assert.throws(() => gate(opts(root, { scopes: ['srcc'] })), /--scope does not exist/);
  assert.throws(() => gate(opts(root, { scopes: ['../elsewhere'] })), /inside the root/);
}));

test('--scope . and --exclude . mean the whole root, not "nothing"', () => fixture(({ root }) => {
  assert.equal(gate(opts(root, { scopes: ['.'], excludes: [], old: ['obsoleteHandler'] })).status, 'FAIL');
  assert.equal(gate(opts(root, { excludes: ['.'] })).status, 'INCOMPLETE', 'excluding everything searches nothing, which cannot pass');
}));

test('a scope that exists but holds no searchable files is INCOMPLETE', () => fixture(({ root }) => {
  fs.mkdirSync(path.join(root, 'empty'));
  const result = gate(opts(root, { scopes: ['empty'] }));
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.coverage.incomplete.some(gap => gap.kind === 'scope matched no files' && gap.path === 'empty'));
}));

test('files of any language are searched, including .kt and .rules', () => inProject(({ root, put }) => {
  put('src/Thing.kt', 'fun legacyThing() = 1\n');
  put('rules/firestore.rules', 'allow read: if legacyRule();\n');
  put('Dockerfile', 'ENV LEGACY_MODE=1\n');
  const result = gate({ root, old: ['legacyThing', 'legacyRule', 'LEGACY_MODE'] });
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.errors.map(e => e.path).sort(), ['Dockerfile', 'rules/firestore.rules', 'src/Thing.kt']);
}));

test('a file too large to search makes the result INCOMPLETE instead of a silent PASS', () => inProject(({ root, put }) => {
  put('src/ok.ts', 'export {};\n');
  put('src/huge.ts', `${'x'.repeat(5000)} obsoleteName\n`);
  const small = gate({ root, old: ['obsoleteName'], maxBytes: 1000 });
  assert.equal(small.status, 'INCOMPLETE');
  assert.deepEqual(small.coverage.incomplete[0].paths, ['src/huge.ts']);
  assert.equal(gate({ root, old: ['obsoleteName'] }).status, 'FAIL', 'with the default limit the file is searched and the match found');
}));

test('unreadable files and folders make the result INCOMPLETE', { skip: isRoot ? 'root can read everything' : false }, () => inProject(({ root, put }) => {
  put('src/ok.ts', 'export {};\n');
  put('locked/a.ts', 'export {};\n');
  put('src/secret.ts', 'export {};\n');
  fs.chmodSync(path.join(root, 'locked'), 0o000);
  fs.chmodSync(path.join(root, 'src/secret.ts'), 0o000);
  try {
    const result = gate({ root, old: ['nothing'] });
    assert.equal(result.status, 'INCOMPLETE');
    const kinds = result.coverage.incomplete.map(gap => gap.kind);
    assert.ok(kinds.includes('unreadable files were not searched'));
    assert.ok(kinds.includes('unreadable directories were not searched'));
  } finally {
    fs.chmodSync(path.join(root, 'locked'), 0o755);
    fs.chmodSync(path.join(root, 'src/secret.ts'), 0o644);
  }
}));

test('a repository with nothing searchable cannot PASS', () => inProject(({ root }) => {
  assert.equal(gate({ root, old: ['anything'] }).status, 'INCOMPLETE');
}));

test('--forbid-path catches dangling symlinks and rejects escaping or root paths', () => inProject(({ root, put }) => {
  put('src/ok.ts', 'export {};\n');
  fs.symlinkSync('/does/not/exist', path.join(root, 'retired-link'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'code-cleaner-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.deepEqual(gate({ root, forbidPaths: ['retired-link'] }).errors.map(e => e.kind), ['forbidden path still exists']);
    assert.equal(gate({ root, forbidPaths: ['nothing-here'] }).status, 'PASS');
    assert.throws(() => gate({ root, forbidPaths: ['../x'] }), /inside the root/);
    assert.throws(() => gate({ root, forbidPaths: ['escape/file'] }), /outside the root/);
    assert.throws(() => gate({ root, forbidPaths: ['.'] }), /repository root/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('--word separates saveTask from saveTaskV2; --ignore-case finds case variants', () => inProject(({ root, put }) => {
  put('src/a.ts', 'saveTaskV2();\nexport const a_saveTask_b = 1;\n$saveTask;\n');
  assert.equal(gate({ root, old: ['saveTask'] }).errors[0].occurrences, 3, 'plain mode is a substring match');
  const word = gate({ root, old: ['saveTask'], word: true });
  assert.equal(word.status, 'PASS', 'saveTaskV2, a_saveTask_b and $saveTask contain the word only as part of a longer identifier');
  put('src/b.ts', 'saveTask();\n');
  assert.equal(gate({ root, old: ['saveTask'], word: true }).errors[0].path, 'src/b.ts');
  put('src/c.ts', 'SAVETASK()\n');
  assert.equal(gate({ root, old: ['saveTask'], word: true, ignoreCase: true }).errors.length, 2);
}));

test('--word does not constrain edges that are not identifier characters', () => inProject(({ root, put }) => {
  put('src/a.ts', 'obj.legacyCall();\nimport x from "./old/";\n');
  assert.equal(gate({ root, old: ['.legacyCall'], word: true }).status, 'FAIL');
  assert.equal(gate({ root, old: ['./old/'], word: true }).status, 'FAIL');
}));

test('regex metacharacters in literals are matched literally', () => inProject(({ root, put }) => {
  put('src/a.ts', 'const price = (a+b)*c; const s = "[x]";\n');
  assert.equal(gate({ root, old: ['(a+b)*c'] }).status, 'FAIL');
  assert.equal(gate({ root, old: ['a.b'] }).status, 'PASS');
  assert.equal(gate({ root, old: ['[x]'] }).status, 'FAIL');
}));

test('multi-line literals and line numbers are reported correctly', () => inProject(({ root, put }) => {
  put('src/a.ts', 'one\ntwo\nlegacy(\n  call)\nlegacy(\n');
  const result = gate({ root, old: ['legacy('] });
  assert.deepEqual(result.errors[0].lines, [3, 5]);
  assert.equal(gate({ root, old: ['legacy(\n  call)'] }).errors[0].lines[0], 3);
}));

test('build output is skipped only at the root and the skip is reported', () => inProject(({ root, put }) => {
  put('src/ok.ts', 'export {};\n');
  put('build/generated.js', 'obsoleteName\n');
  put('src/build/helper.ts', 'obsoleteName\n');
  const result = gate({ root, old: ['obsoleteName'] });
  assert.deepEqual(result.errors.map(e => e.path), ['src/build/helper.ts']);
  assert.deepEqual(result.coverage.skippedDirectories, ['build']);
}));

test('getOptions validates input', () => {
  assert.throws(() => getOptions([]), /at least one/);
  assert.throws(() => getOptions(['--old', 'x', '--max-bytes', '0']), /positive integer/);
  assert.equal(getOptions(['--help']), null);
  assert.deepEqual(getOptions(['--old=--flag', '--word']).old, ['--flag']);
});

// ---- command line contract: exit codes ----

test('exit codes: 0 PASS, 1 FAIL, 2 error, 3 INCOMPLETE', () => fixture(({ root }) => {
  const run = args => runScript('gate.mjs', ['--root', root, ...args]);
  assert.equal(run(['--old', 'nothingLikeThis', '--require', 'canonicalHandler']).status, 0);
  assert.equal(run(['--old', 'canonicalHandler']).status, 1);
  assert.equal(run(['--old', 'x', '--scope', 'typo']).status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--old', 'x', '--max-bytes', '1']).status, 3);
  const json = JSON.parse(run(['--old', 'canonicalHandler', '--json']).stdout);
  assert.equal(json.status, 'FAIL');
  assert.deepEqual(Object.keys(json), ['tool', 'version', 'root', 'status', 'searchedFiles', 'checks', 'coverage', 'errorTotal', 'errors', 'warning']);
}));

test('output never contains file contents and neutralizes hostile paths', () => inProject(({ root, put }) => {
  put('src/a.ts', 'const apiKey = "SUPER-SECRET-VALUE"; obsoleteName();\n');
  put('src/evil\n## FORGED_old.ts', 'obsoleteName\n');
  const result = runScript('gate.mjs', ['--root', root, '--old', 'obsoleteName']);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('SUPER-SECRET-VALUE'));
  assert.ok(!result.stdout.includes('\n## FORGED'));
}));

// ---- globs, output caps and warnings ----

test('pathMatcher: prefixes, name globs, anchored globs and ** behave like gitignore users expect', () => {
  const match = (pattern, file) => pathMatcher(pattern).test(file);
  assert.ok(match('docs', 'docs/a.md') && !match('docs', 'docsx/a.md'));
  assert.ok(match('*.md', 'README.md') && match('*.md', 'a/b/c.md') && !match('*.md', 'a/b/c.mdx'));
  assert.ok(match('**/*.lock', 'x.lock') && match('**/*.lock', 'a/b/x.lock'));
  assert.ok(match('android/**', 'android/app/x.kt') && !match('android/**', 'ios/x.kt'));
  assert.ok(match('src/*.ts', 'src/a.ts') && !match('src/*.ts', 'src/deep/a.ts'));
  assert.ok(match('a?.ts', 'ab.ts') && !match('a?.ts', 'a/b.ts'));
  assert.ok(match('src/legacy/**', 'src/legacy/x/y.ts'));
  assert.ok(!match('*.min.js', 'src/min.json'), 'regex metacharacters in the glob are literal');
  assert.throws(() => pathMatcher('../*.md'), /inside the root/);
  assert.throws(() => pathMatcher('/abs/*.md'), /inside the root/);
});

test('glob excludes and scopes work in a real run, and a glob scope matching nothing is INCOMPLETE', () => inProject(({ root, put }) => {
  put('src/a.ts', 'ok\n');
  put('CHANGELOG.md', 'getUser was renamed\n');
  put('android/Foo.kt', 'getUser()\n');
  put('web/vendor.min.js', 'getUser()\n');
  assert.equal(gate({ root, old: ['getUser'] }).errorTotal, 3);
  assert.equal(gate({ root, old: ['getUser'], excludes: ['*.md', 'android/**', '**/*.min.js'] }).status, 'PASS');
  assert.equal(gate({ root, old: ['getUser'], scopes: ['**/*.kt'] }).errors[0].path, 'android/Foo.kt');
  const none = gate({ root, old: ['getUser'], scopes: ['**/*.swift'] });
  assert.equal(none.status, 'INCOMPLETE');
  assert.ok(none.coverage.incomplete.some(gap => gap.kind === 'scope matched no files'));
}));

test('an exclude that matches nothing is reported so a typo cannot hide', () => inProject(({ root, put }) => {
  put('src/a.ts', 'ok\n');
  const result = gate({ root, old: ['zzz'], excludes: ['androidd', '*.md'] });
  assert.deepEqual(result.coverage.unmatchedExcludes, ['androidd', '*.md']);
  assert.match(runScript('gate.mjs', ['--root', root, '--old', 'zzz', '--exclude', 'androidd']).stdout, /--exclude matched no files/);
}));

test('violations are counted in full but only a bounded number is printed', () => inProject(({ root, put }) => {
  for (let i = 0; i < 300; i++) put(`f${i}.ts`, 'obsoleteName();\n');
  const result = gate({ root, old: ['obsoleteName'] });
  assert.equal(result.errorTotal, 300);
  assert.equal(result.errors.length, 200, 'JSON is capped');
  const text = runScript('gate.mjs', ['--root', root, '--old', 'obsoleteName']).stdout;
  assert.equal(text.split('\n').filter(line => line.startsWith('- obsolete literal')).length, 50);
  assert.match(text, /250 more violations not shown/);
  assert.equal(runScript('gate.mjs', ['--root', root, '--old', 'obsoleteName']).status, 1);
}));
