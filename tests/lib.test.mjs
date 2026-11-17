import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRelative, overlaps, clean, redactSecrets, parseFlags, walk, existsNoFollow, compareText,
} from '../scripts/lib.mjs';
import { inProject } from './helpers.mjs';

test('normalizeRelative accepts inside paths and normalizes them', () => {
  assert.equal(normalizeRelative('src/'), 'src');
  assert.equal(normalizeRelative('./src//app'), 'src/app');
  assert.equal(normalizeRelative('src\\app'), 'src/app');
  assert.equal(normalizeRelative('src/../lib'), 'lib');
  assert.equal(normalizeRelative('.'), '');
  assert.equal(normalizeRelative('./'), '');
});

test('normalizeRelative rejects anything that leaves the root', () => {
  for (const bad of ['..', '../x', 'a/../../x', '/etc/passwd', 'C:\\Windows', 'src/../../..', '']) {
    assert.throws(() => normalizeRelative(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeRelative('a\0b'), /NUL/);
});

test('overlaps treats the empty prefix as the whole root and does not match siblings', () => {
  assert.ok(overlaps('src/a.ts', ''));
  assert.ok(overlaps('src/a.ts', 'src'));
  assert.ok(overlaps('src', 'src'));
  assert.ok(!overlaps('srcs/a.ts', 'src'));
});

test('clean neutralizes control characters, bidi overrides and backticks, and truncates', () => {
  assert.equal(clean('a\nb\r\tc'), 'a?b??c');
  assert.equal(clean('x\u202Ey'), 'x?y');
  assert.equal(clean('`rm -rf`'), "'rm -rf'");
  assert.equal(clean('a'.repeat(300), 10).length, 10);
});

test('clean is safe to pass to Array.map (the index must not become the length limit)', () => {
  assert.deepEqual(['src/a.ts:12', 'src/b.ts:34', 'src/c.ts:56'].map(clean), ['src/a.ts:12', 'src/b.ts:34', 'src/c.ts:56']);
});

test('redactSecrets hides credentials but keeps ordinary long words', () => {
  assert.ok(!redactSecrets('/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz12345/send').includes('ABCdef'));
  assert.ok(!redactSecrets('https://user:hunter2@host/x').includes('hunter2'));
  assert.ok(!redactSecrets('sk_live_51Habcdefghijklmnop').includes('51Habc'));
  assert.ok(!redactSecrets('/v1/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8').includes('a1b2c3d4e5f6'));
  assert.equal(redactSecrets('/api/user-notification-preferences-history'), '/api/user-notification-preferences-history');
});

test('parseFlags supports --flag=value, repeats and rejects swallowed flags', () => {
  const spec = { '--root': { key: 'root', kind: 'value' }, '--old': { key: 'old', kind: 'multi' }, '--json': { key: 'json', kind: 'bool' } };
  const defaults = { root: '.', old: [], json: false };
  assert.deepEqual(parseFlags(['--old=--dash', '--old', 'b', '--json', '--root=/x'], spec, defaults), { root: '/x', old: ['--dash', 'b'], json: true });
  assert.equal(parseFlags(['--help'], spec, defaults), null);
  assert.throws(() => parseFlags(['--root', '--json'], spec, defaults), /Missing value for --root/);
  assert.throws(() => parseFlags(['--root'], spec, defaults), /Missing value for --root/);
  assert.throws(() => parseFlags(['--root='], spec, defaults), /Missing value/);
  assert.throws(() => parseFlags(['--nope'], spec, defaults), /Unknown option/);
  assert.throws(() => parseFlags(['stray'], spec, defaults), /Unexpected argument/);
  assert.deepEqual(defaults, { root: '.', old: [], json: false }, 'defaults must not be mutated');
});

test('walk skips dependency folders everywhere but build output only at the root', () => inProject(({ root, put }) => {
  put('node_modules/a/index.js');
  put('src/node_modules/b/index.js');
  put('build/out.js');
  put('src/build/real.ts');
  put('src/vendor/lib.ts');
  put('b.ts');
  put('a.ts');
  const result = walk(root);
  assert.deepEqual(result.files.map(f => f.relative), ['a.ts', 'b.ts', 'src/build/real.ts', 'src/vendor/lib.ts']);
  assert.deepEqual(result.skippedDirs, ['build', 'node_modules', 'src/node_modules']);
}));

test('walk never follows symlinks and counts them', () => inProject(({ root, put }) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;');
  try {
    put('src/a.ts');
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked-file.ts'));
    const result = walk(root);
    assert.deepEqual(result.files.map(f => f.relative), ['src/a.ts']);
    assert.equal(result.symlinks, 2);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('existsNoFollow sees dangling symlinks and refuses parents that escape the root', () => inProject(({ root, put }) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'outside-'));
  try {
    put('real.txt');
    fs.symlinkSync('/definitely/not/here', path.join(root, 'dangling'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.equal(existsNoFollow(root, 'real.txt'), true);
    assert.equal(existsNoFollow(root, 'dangling'), true);
    assert.equal(existsNoFollow(root, 'missing/deeper'), false);
    assert.throws(() => existsNoFollow(root, 'escape/file'), /outside the root/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('compareText is locale independent', () => {
  assert.deepEqual(['b', 'B', 'a', 'A'].sort(compareText), ['A', 'B', 'a', 'b']);
});
