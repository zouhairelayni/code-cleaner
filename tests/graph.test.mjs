import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, pythonImports, pythonDynamicLines, readJsonLoose, analyzeProject } from '../scripts/graph.mjs';
import { inProject } from './helpers.mjs';

const resolverFor = (put, root, files) => {
  for (const [name, text] of Object.entries(files)) put(name, typeof text === 'string' ? text : JSON.stringify(text));
  return createResolver({ allPaths: new Set(Object.keys(files)), root });
};

test('relative imports resolve extensions, index files and TypeScript ESM .js specifiers', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, { 'src/a.ts': '', 'src/b/index.tsx': '', 'src/c.mts': '', 'src/d.json': '', 'src/main.ts': '' });
  assert.equal(r.resolve('src/main.ts', './a').resolved, 'src/a.ts');
  assert.equal(r.resolve('src/main.ts', './a.js').resolved, 'src/a.ts');
  assert.equal(r.resolve('src/main.ts', './b').resolved, 'src/b/index.tsx');
  assert.equal(r.resolve('src/main.ts', './c.mjs').resolved, 'src/c.mts');
  assert.equal(r.resolve('src/main.ts', './d.json').resolved, 'src/d.json');
  assert.deepEqual(r.resolve('src/main.ts', './missing'), { resolved: null, local: true });
  assert.deepEqual(r.resolve('src/main.ts', 'react'), { resolved: null, local: false });
  assert.equal(r.resolve('src/main.ts', './a?raw').resolved, 'src/a.ts');
  assert.equal(r.resolve('src/main.ts', 'node:fs').local, false);
}));

test('tsconfig extends: child paths replace the parent paths, baseUrl is inherited relative to its own file', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'tsconfig.base.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["libs/shared/*"], }, }, }',
    'apps/web/tsconfig.json': { extends: '../../tsconfig.base.json', compilerOptions: { paths: { '@/*': ['./src/*'] } } },
    'apps/web/src/x.ts': '', 'apps/web/src/main.ts': '', 'libs/shared/y.ts': '', 'libs/shared/z.ts': '',
  });
  assert.equal(r.resolve('apps/web/src/main.ts', '@/x').resolved, 'apps/web/src/x.ts');
  assert.equal(r.resolve('apps/web/src/main.ts', '@shared/y').resolved, null, "TypeScript replaces, not merges, paths; the parent's alias is gone");
  assert.equal(r.resolve('apps/web/src/main.ts', 'libs/shared/z').resolved, 'libs/shared/z.ts', 'baseUrl "." from the base config still applies');
}));

test('self-referencing and cyclic extends, and wrongly typed compilerOptions, do not crash', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'tsconfig.json': { extends: './tsconfig.json', compilerOptions: { paths: { '@/*': 'not-an-array', x: [1, null, {}] }, baseUrl: 42 } },
    'a/tsconfig.json': { extends: ['./b.json', '../tsconfig.json'] }, 'a/b.json': { extends: './tsconfig.json' }, 'a/m.ts': '',
  });
  assert.doesNotThrow(() => r.resolve('a/m.ts', '@/anything'));
  assert.doesNotThrow(() => r.resolve('a/m.ts', 'x'));
}));

test('workspace packages resolve by name, subpath, exports map, wildcard exports and dist -> src', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'libs/kit/package.json': { name: '@h/kit', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' }, './colors': './dist/colors.js', './icons/*': './src/icons/*.ts' } },
    'libs/kit/src/index.ts': '', 'libs/kit/src/colors.ts': '', 'libs/kit/src/icons/star.ts': '', 'libs/kit/src/extra.ts': '',
    'libs/plain/package.json': { name: 'plain', main: 'lib/main.js' }, 'libs/plain/lib/main.js': '', 'libs/plain/helpers.js': '',
    'app/src/main.ts': '',
  });
  assert.equal(r.resolve('app/src/main.ts', '@h/kit').resolved, 'libs/kit/src/index.ts');
  assert.equal(r.resolve('app/src/main.ts', '@h/kit/colors').resolved, 'libs/kit/src/colors.ts');
  assert.equal(r.resolve('app/src/main.ts', '@h/kit/icons/star').resolved, 'libs/kit/src/icons/star.ts');
  assert.equal(r.resolve('app/src/main.ts', '@h/kit/extra').resolved, 'libs/kit/src/extra.ts', 'unlisted subpath falls back to src/');
  assert.equal(r.resolve('app/src/main.ts', 'plain').resolved, 'libs/plain/lib/main.js');
  assert.equal(r.resolve('app/src/main.ts', 'plain/helpers').resolved, 'libs/plain/helpers.js');
  assert.deepEqual(r.resolve('app/src/main.ts', '@h/kit/nope'), { resolved: null, local: true });
  assert.equal(r.workspacePackages, 2);
}));

test('conventional aliases: @/ ~/ $lib and baseUrl bare imports', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'kit/src/lib/a.ts': '', 'kit/src/routes/p.ts': '', 'app/src/x.ts': '', 'app/m.ts': '',
    'bu/tsconfig.json': { compilerOptions: { baseUrl: 'src' } }, 'bu/src/lib/f.ts': '', 'bu/src/m.ts': '',
  });
  assert.equal(r.resolve('kit/src/routes/p.ts', '$lib/a').resolved, 'kit/src/lib/a.ts');
  assert.equal(r.resolve('app/m.ts', '@/x').resolved, 'app/src/x.ts');
  assert.equal(r.resolve('bu/src/m.ts', 'lib/f').resolved, 'bu/src/lib/f.ts');
}));

test('package entry points include main, bin and exports for the root and workspace packages', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'bin/cli.js': '', 'lib/entry.js': '', 'pkg/package.json': { name: 'p', main: 'index.js' }, 'pkg/index.js': '', 'x/y.mjs': '',
  });
  const found = r.entrypoints({ main: 'lib/entry.js', bin: { c: './bin/cli.js' }, exports: { './y': { import: './x/y.mjs' } } });
  assert.deepEqual([...found].sort(), ['bin/cli.js', 'lib/entry.js', 'pkg/index.js', 'x/y.mjs']);
}));

test('readJsonLoose handles comments, trailing commas and strings containing //', () => inProject(({ root, put }) => {
  const file = put('t.json', '{ // c\n "u": "http://x", /* b */ "a": [1, 2,], }');
  assert.deepEqual(readJsonLoose(file), { u: 'http://x', a: [1, 2] });
  assert.equal(readJsonLoose(put('bad.json', '{ nope')), null);
  assert.equal(readJsonLoose('/definitely/missing.json'), null);
}));

test('python imports: absolute, relative, aliased, parenthesised and multi-line', () => {
  const refs = pythonImports("import os, a.b as c\nfrom pkg.mod import (\n    x,\n    y as z,\n)\nfrom . import sib\nfrom ..up import thing\nimport  \nfrom ...... import q\n");
  assert.deepEqual(refs.map(ref => [ref.level, ref.module, ref.names.join('+')]), [[0, 'os', ''], [0, 'a.b', ''], [0, 'pkg.mod', 'x+y'], [1, '', 'sib'], [2, 'up', 'thing'], [6, '', 'q']]);
  assert.deepEqual(pythonDynamicLines("x = 1\nimportlib.import_module(name)\n__import__('a')\n"), [2, 3]);
});

const project = (files, { tests = () => false, anchor = () => false, config = () => false, manifest = {} } = {}) => inProject(({ root, put }) => {
  const list = Object.entries(files);
  for (const [name, text] of list) put(name, text);
  return analyzeProject({
    files: list.map(([path, text]) => ({ path, text })), allPaths: new Set(Object.keys(files)), root,
    isTest: tests, isAnchor: anchor, isReferencedByConfig: config, rootManifest: manifest,
  });
});

test('python: package init chains, relative imports and submodule names reach their targets', () => {
  const result = project({
    'svc/main.py': "from pipeline.steps import clean\nfrom . import helper\nfrom pipeline import extra\n",
    'svc/helper.py': '', 'svc/pipeline/__init__.py': '', 'svc/pipeline/steps.py': '', 'svc/pipeline/extra.py': '', 'svc/pipeline/dead.py': '',
  }, { anchor: file => file === 'svc/main.py' });
  assert.deepEqual(result.candidates, ['svc/pipeline/dead.py']);
});

test('classification: cycles, chains and test-only modules', () => {
  const result = project({
    'entry.ts': "import './alive';", 'alive.ts': '',
    'cycleA.ts': "import './cycleB';", 'cycleB.ts': "import './cycleA';",
    'top.ts': "import './leaf';", 'leaf.ts': '',
    'tested.ts': '', 'tested.test.ts': "import './tested';",
  }, { anchor: file => file === 'entry.ts', tests: file => file.endsWith('.test.ts') });
  assert.deepEqual(result.candidates, ['top.ts']);
  assert.deepEqual(result.deadChains, ['leaf.ts']);
  assert.deepEqual(result.isolatedCycles, ['cycleA.ts', 'cycleB.ts']);
  assert.deepEqual(result.testOnly, ['tested.ts']);
});

test('classification: a manifest-referenced file keeps everything it imports alive', () => {
  const files = { 'job.ts': "import './task';", 'task.ts': '', 'orphan.ts': '' };
  const result = project(files, { config: file => file === 'job.ts' });
  assert.deepEqual(result.candidates, ['orphan.ts']);
  assert.equal(result.rescuedByConfig, 1);
});

test('vue and svelte components are modules: unused ones are found, imported ones are not', () => {
  const result = project({
    'src/main.ts': "import A from './A.vue';", 'src/A.vue': "<script>\nimport B from './B.svelte';\n</script>", 'src/B.svelte': '<p/>', 'src/Dead.vue': '<p/>',
  }, { anchor: file => file === 'src/main.ts' });
  assert.deepEqual(result.candidates, ['src/Dead.vue']);
});

test('unused exports: public API and framework entry files are exempt, own-file use does not count', () => {
  const result = project({
    'pkg/package.json': JSON.stringify({ name: 'pkg', main: 'src/index.ts' }),
    'pkg/src/index.ts': "export * from './api';", 'pkg/src/api.ts': 'export const publicApi = 1;',
    'app/main.ts': "import { used } from './lib';", 'app/lib.ts': 'export const used = 1;\nexport const unused = 2;\nconst local = unused;\nexport function selfOnly() { return selfOnly; }',
  }, { anchor: file => file === 'app/main.ts' });
  assert.deepEqual(result.unusedExports.map(entry => entry.name), ['unused', 'selfOnly']);
});

test('exports that point into dist/ map to the source file even when no name-based fallback could find it', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, {
    'libs/odd/package.json': { name: '@h/odd', exports: { '.': './dist/main.js', './tint': './dist/colors.js' }, main: './dist/main.js' },
    'libs/odd/src/main.ts': '', 'libs/odd/src/colors.ts': '', 'app/m.ts': '',
  });
  assert.equal(r.resolve('app/m.ts', '@h/odd').resolved, 'libs/odd/src/main.ts');
  assert.equal(r.resolve('app/m.ts', '@h/odd/tint').resolved, 'libs/odd/src/colors.ts');
  assert.ok(r.entrypoints({}).has('libs/odd/src/main.ts'), 'the package entry point is the source file');
}));

test('python: imports rooted at the scanned package itself, and dotted module names in strings, are followed', () => {
  const files = {
    'pkg/__main__.py': 'from pkg.cli.main import main\n',
    'pkg/cli/main.py': 'COMMANDS = {"run": ("pkg.commands.run", "RunCommand")}\n',
    'pkg/commands/run.py': '', 'pkg/commands/orphan.py': '', 'pkg/cli/__init__.py': '',
  };
  const run = rootName => inProject(({ root, put }) => {
    for (const [name, text] of Object.entries(files)) put(name, text);
    // the scanned directory is `root/pkg`, so scan from inside it
    const scanRoot = `${root}/pkg`;
    const inside = Object.fromEntries(Object.entries(files).map(([name, text]) => [name.replace(/^pkg\//, ''), text]));
    return analyzeProject({
      files: Object.entries(inside).map(([path, text]) => ({ path, text })), allPaths: new Set(Object.keys(inside)), root: scanRoot,
      isTest: () => false, isAnchor: file => file === '__main__.py', isReferencedByConfig: () => false, rootManifest: {},
    });
  });
  assert.deepEqual(run().candidates, ['commands/orphan.py'], 'cli/main.py and commands/run.py are reached; only the orphan is not');
});

test('soft references keep a file alive but are never reported as unresolved imports', () => inProject(({ root, put }) => {
  const result = project({ 'a.js': "path.join(__dirname, 'missing/file.js'); const s = './also-missing.js';", 'b.js': "const s = './a.js';" }, { anchor: file => file === 'b.js' });
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.candidates, [], 'b.js names ./a.js, so a.js is reachable');
}));

test('platform-specific files resolve and share one edge set (React Native, Expo, Metro)', () => inProject(({ root, put }) => {
  const r = resolverFor(put, root, { 'src/App.tsx': '', 'src/Button.ios.tsx': '', 'src/Button.android.tsx': '', 'src/Plain.tsx': '', 'src/Plain.ios.tsx': '' });
  assert.match(r.resolve('src/App.tsx', './Button').resolved, /Button\.(ios|android)\.tsx$/);
  assert.equal(r.resolve('src/App.tsx', './Plain').resolved, 'src/Plain.tsx', 'a plain file wins over platform variants');
  const result = project({ 'a.tsx': "import './B';", 'B.ios.tsx': '', 'B.android.tsx': '', 'B.web.tsx': '' }, { anchor: file => file === 'a.tsx' });
  assert.deepEqual(result.candidates, [], 'every platform variant is reached by the single import');
}));
