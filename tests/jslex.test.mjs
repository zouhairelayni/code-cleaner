import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, extractModuleInfo, importedSpecifiers, extractEmbeddedScripts } from '../scripts/jslex.mjs';

const specs = source => importedSpecifiers(source);

test('comments, strings and template text never count as imports', () => {
  assert.deepEqual(specs("// import './a'\n/* require('./b') */\nconst s = \"import './c'\";\nconst t = `import x from './d'`;"), []);
});

test("a string containing /* does not swallow the code after it (regression: '/api/*')", () => {
  assert.deepEqual(specs("const m = '/api/*';\nawait import('./target');\n/** doc */\nexport const x = 1;"), ['./target']);
});

test('regex literals are skipped and division is not mistaken for one', () => {
  assert.deepEqual(specs("const r = /['\"]\\/\\*/g; import('./after');"), ['./after']);
  assert.deepEqual(specs("const a = b / c; const d = e / f; require('./x');"), ['./x']);
  assert.deepEqual(specs("const r = /[/]+/; require('./y');"), ['./y']);
  assert.deepEqual(specs("if (x) { y = a /b/ c } import('./z')"), ['./z']);
});

test('template literals with nested expressions, strings and braces are skipped correctly', () => {
  assert.deepEqual(specs("const s = `a ${ x ? `b${y}` : \"}\" } c`; import './z';"), ['./z']);
  assert.deepEqual(specs(`const s = \`\${'${'`'}'}\`; import './after';`), ['./after']);
});

test('JSX text with apostrophes and closing tags damages at most its own line', () => {
  assert.deepEqual(specs("const el = <div>don't <b>x</b></div>;\nimport('./jsx');"), ['./jsx']);
});

test('unterminated strings and templates end at the line or file, never crash', () => {
  assert.deepEqual(specs("const s = 'abc\nimport './next';"), ['./next']);
  assert.deepEqual(specs('const t = `never closed ${ x'), []);
  assert.deepEqual(specs('/* never closed'), []);
  assert.deepEqual(specs(''), []);
});

test('every module-loading form is recognised', () => {
  const source = [
    "import a from './a';", "import './side';", "import {\n  b,\n} from './multi';", "import type { T } from './types';",
    "import d, { e } from './d';", "import * as ns from './ns';", "import f = require('./f');", "const g = require('./g');",
    "const h = await import('./h');", "export * from './i';", "export * as j from './j';", "export { k } from './k';",
    "export type { L } from './l';", "require.resolve('./m');", "new Worker(new URL('./n.ts', import.meta.url));",
    "jest.mock('./o');", "vi.doMock('./p');", "const q = import(`./static`);",
  ].join('\n');
  assert.deepEqual(specs(source), ['./a', './side', './multi', './types', './d', './ns', './f', './g', './h', './i', './j', './k', './l', './m', './n.ts', './o', './p', './static']);
});

test('property names and non-loading look-alikes are ignored', () => {
  assert.deepEqual(specs("foo.require('./no'); obj.import('./no2'); const require = 1; new URL('./u', base); expect(import_('./v'));"), []);
});

test('kinds distinguish re-exports from imports', () => {
  const { refs } = extractModuleInfo("import './a'; export * from './b'; export { x } from './c'; require('./d');");
  assert.deepEqual(refs.map(ref => ref.kind), ['import', 'reexport', 'reexport', 'require']);
});

test('non-literal loads are reported as dynamic with their line numbers', () => {
  const { dynamic, refs } = extractModuleInfo("import(`./p/${id}`);\nimport(name);\nimport.meta.glob('./r/*.ts');\nrequire(x);\nrequire.context('./c');\nimport(`./static`);\nimport('./lit');");
  assert.deepEqual(dynamic, [1, 2, 3, 4, 5]);
  assert.deepEqual(refs.map(ref => ref.spec), ['./static', './lit']);
});

test('named exports are collected, default and destructured exports are not', () => {
  const { exports } = extractModuleInfo([
    'export function f(){}', 'export const { a } = o;', 'export { g as h, i };', 'export default class K {}',
    'export interface I {}', 'export async function* gen(){}', 'export type T = string;', 'export enum E {}',
    'export declare const d: number;', "export { z } from './z';",
  ].join('\n'));
  assert.deepEqual(exports.map(entry => entry.name), ['f', 'h', 'i', 'I', 'gen', 'T', 'E', 'd']);
});

test('identifiers used in code are indexed, text in strings and comments is not', () => {
  const { idents } = extractModuleInfo("const used = 1; // commented\nconst s = 'inString'; obj.member; <Tag />");
  assert.ok(idents.has('used') && idents.has('member') && idents.has('Tag'));
  assert.ok(!idents.has('commented') && !idents.has('inString'));
});

test('line numbers survive multi-line comments, strings and templates', () => {
  const { refs } = extractModuleInfo("/*\n\n*/\nconst t = `a\nb`;\nimport './x';");
  assert.equal(refs[0].line, 6);
});

test('tokenizer survives deep nesting and very long input quickly', () => {
  const started = Date.now();
  assert.ok(tokenize(`const x = ${'`${'.repeat(300)}1${'}`'.repeat(300)};`).length > 0);
  assert.ok(tokenize(`const a = '${'x'.repeat(3_000_000)}';`).length > 0);
  assert.ok(tokenize('a,'.repeat(500_000)).length > 0);
  assert.ok(Date.now() - started < 5000);
});

test('script blocks are extracted from Vue, Svelte, Astro and MDX', () => {
  assert.deepEqual(specs(extractEmbeddedScripts("<template/><script setup lang=\"ts\">\nimport a from './a';\n</script><script>import b from './b'</script>", '.vue')), ['./a', './b']);
  assert.deepEqual(specs(extractEmbeddedScripts('---\nimport L from "./L.astro";\n---\n<L/>', '.astro')), ['./L.astro']);
  assert.deepEqual(specs(extractEmbeddedScripts("import X from './x'\n\n# Title", '.mdx')), ['./x']);
});

test('paths built from __dirname or import.meta.dirname count as soft references (regression: npm cli/entry.js)', () => {
  const { refs } = extractModuleInfo([
    "const a = require('node:path').resolve(__dirname, 'cli/entry.js');", "path.join(__dirname, 'lib', 'x.js');", "const b = __dirname + '/legacy/y.js';",
    "join(import.meta.dirname, 'z.mjs');", "path.join(__dirname, name);", "path.join(__dirname, 'views');",
  ].join('\n'));
  assert.deepEqual(refs.filter(ref => ref.kind === 'path').map(ref => [ref.spec, ref.kind, ref.soft]), [['./cli/entry.js', 'path', true], ['./lib/x.js', 'path', true], ['./legacy/y.js', 'path', true], ['./z.mjs', 'path', true]]);
});

test('a plain relative file path in a string is a soft reference; import specifiers are not double counted', () => {
  const { refs } = extractModuleInfo("const routes = { home: './routes/home.js', style: './x.css' };\nimport a from './a.js';\nrequire('./b.js');\nimport('./c.js');");
  assert.deepEqual(refs.map(ref => [ref.spec, ref.kind]), [['./routes/home.js', 'string'], ['./a.js', 'import'], ['./b.js', 'require'], ['./c.js', 'dynamic']]);
});
