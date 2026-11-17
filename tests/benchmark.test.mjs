/**
 * Accuracy benchmark. Each fixture is a realistic repository with an answer key:
 *   alive  files that must NEVER be offered as removable (a false positive here is dangerous)
 *   dead   files that should be offered (a miss here means dead code survives an audit)
 * "monorepo" was used while developing the scanner; "heldout" was written first and
 * measured before any tuning, to expose overfitting. Keep both at zero errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../scripts/scan.mjs';
import { inProject, runScript } from './helpers.mjs';

const load = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const LEAD_BUCKETS = ['unreferencedModuleCandidates', 'deadChains', 'isolatedCycles', 'testOnlyModules'];

function scanFixture(fixture, run) {
  return inProject(({ root }) => {
    for (const [relative, text] of Object.entries(fixture.files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    const report = audit(root);
    return run(report.findings, report.coverage);
  });
}

for (const name of ['monorepo', 'heldout']) {
  const fixture = load(name);

  test(`${name}: no live file is offered as removable`, () => scanFixture(fixture, findings => {
    const flagged = new Map();
    for (const bucket of LEAD_BUCKETS) for (const file of findings[bucket]) flagged.set(file, bucket);
    const falsePositives = fixture.truth.alive.filter(file => flagged.has(file)).map(file => `${file} (${flagged.get(file)})`);
    assert.deepEqual(falsePositives, []);
  }));

  test(`${name}: every dead file is offered`, () => scanFixture(fixture, findings => {
    const flagged = new Set(LEAD_BUCKETS.flatMap(bucket => findings[bucket]));
    const versioned = new Set(findings.versionedFiles.map(entry => entry.path));
    assert.deepEqual(fixture.truth.dead.filter(file => !flagged.has(file) && !versioned.has(file)), []);
  }));

  test(`${name}: versioned names and unused dependencies match the key`, () => scanFixture(fixture, findings => {
    const versioned = findings.versionedFiles.map(entry => entry.path);
    for (const expected of fixture.truth.versioned_expected) assert.ok(versioned.includes(expected), `missed ${expected}`);
    for (const forbidden of fixture.truth.versioned_forbidden) assert.ok(!versioned.includes(forbidden), `false positive ${forbidden}`);
    const deps = findings.potentialUnusedDependencies.map(dep => dep.replace(/^[^:]*: /, ''));
    for (const dead of fixture.truth.dead_deps) assert.ok(deps.includes(dead), `missed dependency ${dead}`);
    for (const alive of fixture.truth.alive_deps) assert.ok(!deps.includes(alive), `false positive dependency ${alive}`);
  }));
}

test('monorepo: unused exports, duplicate regions and dynamic loads are reported', () => scanFixture(load('monorepo'), findings => {
  const names = findings.unusedExports.map(entry => entry.name);
  for (const expected of load('monorepo').truth.dead_exports) assert.ok(names.includes(expected), `missed export ${expected}`);
  assert.equal(findings.repeatedCodeBlockTotal, 1);
  assert.ok(findings.dynamicLoadSites.some(site => site.startsWith('apps/api/src/plugins/loader.ts')));
  assert.equal(findings.unresolvedImportTotal, 0);
}));

test('monorepo: each category lands in the right bucket', () => scanFixture(load('monorepo'), findings => {
  assert.deepEqual(findings.deadChains, ['packages/core/src/chain/leaf.ts']);
  assert.deepEqual(findings.isolatedCycles, ['packages/core/src/deadA.ts', 'packages/core/src/deadB.ts']);
  assert.deepEqual(findings.testOnlyModules, ['packages/core/src/onlyTests.ts']);
  assert.ok(findings.unreferencedModuleCandidates.includes('services/ml/pipeline/dead_step.py'));
  assert.ok(findings.unreferencedModuleCandidates.includes('apps/api/src/swallow/phantom.ts'), 'text inside a template literal is not an import');
  assert.ok(!findings.unreferencedModuleCandidates.includes('apps/api/src/swallow/target.ts'), "a '/api/*' string must not swallow the import after it");
}));

test('every report format runs to completion on every fixture, including optional sections', () => {
  for (const name of ['monorepo', 'heldout']) {
    const fixture = load(name);
    inProject(({ root, put }) => {
      for (const [relative, text] of Object.entries(fixture.files)) put(relative, text);
      // Exercise sections the fixtures do not naturally contain.
      put('extra/a.ts', "fetch('https://api.example.com/v1/items');\nconst x = 'legacy fallback';\n");
      put('extra/b.ts', "fetch('https://api.example.com/v1/items');\n");
      for (const format of ['md', 'json']) {
        const result = runScript('scan.mjs', ['--root', root, '--format', format]);
        assert.equal(result.status, 0, `${name} ${format}: ${result.stderr}`);
        if (format === 'json') assert.equal(JSON.parse(result.stdout).findings.repeatedLiteralRequestTotal, 1);
      }
    });
  }
});
