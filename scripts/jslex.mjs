/**
 * Code Cleaner: a small JavaScript/TypeScript tokenizer and module-reference
 * extractor (read-only, dependency-free).
 *
 * Why a tokenizer and not regular expressions: a regex cannot tell code from
 * comments, strings, template literals and regex literals. That produced two
 * silent errors in practice: a string such as '/api/*' opened a "block comment"
 * that swallowed real imports up to the next doc comment, and the text
 * `import x from './y'` inside a template literal counted as a real import.
 *
 * This is not a full parser. It understands comments, string and template
 * literals (including nested ${...}), and regex literals, which is enough to
 * find import/export/require/dynamic-import references reliably. Strings end at
 * a newline, so JSX text such as <p>don't</p> can damage at most one line.
 */

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const isIdStart = char => /[A-Za-z_$]/.test(char) || char > '\x7f';
const isIdPart = char => /[\w$]/.test(char) || char > '\x7f';
const isDigit = char => char >= '0' && char <= '9';
const SPACE = new Set([' ', '\t', '\r', '\f', '\v', '\u00a0', '\ufeff']);

function regexAllowed(tokens) {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  if (prev.t === 'p') return !(prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '<');
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  return false;
}

/** Returns the index just after a regex literal starting at `start`, or -1 when this is not one. */
function scanRegex(source, start) {
  let inClass = false;
  for (let j = start + 1; j < source.length; j++) {
    const char = source[j];
    if (char === '\n') return -1;
    if (char === '\\') { j++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      let end = j + 1;
      while (end < source.length && /[a-z]/.test(source[end])) end++;
      return end;
    }
  }
  return -1;
}

/** Skip a `${ ... }` expression inside a template literal. Returns the index after the closing brace. */
function skipTemplateExpression(source, start, line) {
  let depth = 1;
  let j = start;
  while (j < source.length && depth > 0) {
    const char = source[j];
    if (char === '\n') line++;
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '"' || char === "'") {
      for (j++; j < source.length && source[j] !== char && source[j] !== '\n'; j++) if (source[j] === '\\') j++;
    } else if (char === '`') {
      const inner = readTemplate(source, j, line);
      j = inner.end - 1;
      line = inner.line;
    } else if (char === '/' && source[j + 1] === '/') {
      while (j < source.length && source[j] !== '\n') j++;
      continue;
    } else if (char === '/' && source[j + 1] === '*') {
      const close = source.indexOf('*/', j + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (let k = j; k < stop; k++) if (source[k] === '\n') line++;
      j = stop;
      continue;
    }
    j++;
  }
  return { end: j, line };
}

function readTemplate(source, start, line) {
  let value = '';
  let dynamic = false;
  let j = start + 1;
  while (j < source.length) {
    const char = source[j];
    if (char === '`') { j++; break; }
    if (char === '\\') { value += source[j + 1] ?? ''; if (source[j + 1] === '\n') line++; j += 2; continue; }
    if (char === '$' && source[j + 1] === '{') {
      dynamic = true;
      const inner = skipTemplateExpression(source, j + 2, line);
      j = inner.end;
      line = inner.line;
      continue;
    }
    if (char === '\n') line++;
    value += char;
    j++;
  }
  return { value, dynamic, end: j, line };
}

/** Tokens: { t: 'id' | 'str' | 'tpl' | 're' | 'num' | 'p', v, line }. Comments and whitespace are dropped. */
export function tokenize(source) {
  const tokens = [];
  const length = source.length;
  let i = 0;
  let line = 1;
  while (i < length) {
    const char = source[i];
    if (char === '\n') { line++; i++; continue; }
    if (SPACE.has(char)) { i++; continue; }
    const startLine = line;
    if (char === '/') {
      const next = source[i + 1];
      if (next === '/') { while (i < length && source[i] !== '\n') i++; continue; }
      if (next === '*') {
        const close = source.indexOf('*/', i + 2);
        const stop = close === -1 ? length : close + 2;
        for (let k = i; k < stop; k++) if (source[k] === '\n') line++;
        i = stop;
        continue;
      }
      if (regexAllowed(tokens)) {
        const end = scanRegex(source, i);
        if (end > 0) { tokens.push({ t: 're', v: '', line: startLine }); i = end; continue; }
      }
      tokens.push({ t: 'p', v: '/', line: startLine });
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      let j = i + 1;
      while (j < length && source[j] !== char && source[j] !== '\n') {
        if (source[j] === '\\') { value += source[j + 1] ?? ''; if (source[j + 1] === '\n') line++; j += 2; } else value += source[j++];
      }
      tokens.push({ t: 'str', v: value, line: startLine });
      i = source[j] === char ? j + 1 : j;
      continue;
    }
    if (char === '`') {
      const template = readTemplate(source, i, line);
      tokens.push({ t: 'tpl', v: template.value, dynamic: template.dynamic, line: startLine });
      i = template.end;
      line = template.line;
      continue;
    }
    if (isIdStart(char)) {
      let j = i + 1;
      while (j < length && isIdPart(source[j])) j++;
      tokens.push({ t: 'id', v: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if (isDigit(char)) {
      let j = i + 1;
      while (j < length && /[\w.]/.test(source[j])) j++;
      tokens.push({ t: 'num', v: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    tokens.push({ t: 'p', v: char, line: startLine });
    i++;
  }
  return tokens;
}

const isId = (token, value) => token !== undefined && token.t === 'id' && (value === undefined || token.v === value);
const isP = (token, value) => token !== undefined && token.t === 'p' && token.v === value;
const literal = token => (token && (token.t === 'str' || (token.t === 'tpl' && !token.dynamic)) ? token.v : null);
const DECLARATIONS = new Set(['function', 'class', 'const', 'let', 'var', 'interface', 'type', 'enum', 'namespace']);
const MODIFIERS = new Set(['declare', 'abstract', 'async']);
/** Joined string arguments after __dirname: `, 'a', 'b/c.js'` or `+ '/x.js'`. Empty when any argument is not a plain string. */
function dirnamePath(tokens, k) {
  const parts = [];
  if (isP(tokens[k], '+') && tokens[k + 1]?.t === 'str') parts.push(tokens[k + 1].v);
  else while (isP(tokens[k], ',') && tokens[k + 1]?.t === 'str') { parts.push(tokens[k + 1].v); k += 2; }
  const joined = parts.join('/').replace(/^\/+/, '');
  return joined && /\.[a-z]{1,5}$/i.test(joined) ? joined : '';
}
const MOCK_METHODS = new Set(['mock', 'doMock', 'unmock', 'requireActual', 'importActual', 'requireMock', 'importMock', 'setMock']);

/**
 * Everything the dependency graph needs from one source file:
 *  refs     [{ spec, kind, line, soft? }]  kind: import | reexport | require | dynamic | url | mock | path
 *           soft = a path built from a string, which counts as a reference when it resolves but is never reported as broken
 *  dynamic  [line]                  loads whose target cannot be known statically
 *  idents   Set of identifier names used in code (not in strings or comments)
 *  exports  [{ name, line }]        named exports declared in this file
 */
export function extractModuleInfo(source) {
  const tokens = tokenize(source);
  const refs = [];
  const dynamic = [];
  const idents = new Set();
  const exportsFound = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.t === 'str' && /^\.{1,2}\/[^\s'"`]+\.(?:[cm]?[jt]sx?|json|vue|svelte)$/.test(token.v) && !isId(tokens[i - 1], 'from') && !isP(tokens[i - 1], '(')) {
      // e.g. a registry { home: './routes/home.js' } that is loaded later; require('./x') and import 'x' are handled below
      refs.push({ spec: token.v, kind: 'string', line: token.line, soft: true });
    }
    if (token.t !== 'id') continue;
    idents.add(token.v);
    if (isP(tokens[i - 1], '.')) continue; // obj.require / obj.import are property names, not module loads
    const next = tokens[i + 1];
    if (token.v === 'import') {
      if (next?.t === 'str') refs.push({ spec: next.v, kind: 'import', line: token.line });
      else if (isP(next, '(')) {
        const spec = literal(tokens[i + 2]);
        if (spec !== null && (isP(tokens[i + 3], ')') || isP(tokens[i + 3], ','))) refs.push({ spec, kind: 'dynamic', line: token.line });
        else dynamic.push(token.line);
      } else if (isP(next, '.') && isId(tokens[i + 2], 'meta')) {
        if (isP(tokens[i + 3], '.') && /^glob/.test(tokens[i + 4]?.v ?? '')) dynamic.push(token.line);
        else if (isP(tokens[i + 3], '.') && isId(tokens[i + 4], 'dirname')) {
          const joined = dirnamePath(tokens, i + 5);
          if (joined) refs.push({ spec: `./${joined}`, kind: 'path', line: token.line, soft: true });
        }
      } else {
        for (let j = i + 1, steps = 0; j < tokens.length && steps < 5000; j++, steps++) {
          const clause = tokens[j];
          if (clause.t === 'id') {
            if (clause.v === 'from' && tokens[j + 1]?.t === 'str') { refs.push({ spec: tokens[j + 1].v, kind: 'import', line: token.line }); break; }
            continue;
          }
          if (clause.t === 'p' && '{},*'.includes(clause.v)) continue;
          break;
        }
      }
    } else if (token.v === 'export') {
      let j = i + 1;
      if (isId(tokens[j], 'type') && (isP(tokens[j + 1], '{') || isP(tokens[j + 1], '*'))) j++;
      if (isP(tokens[j], '*')) {
        let k = j + 1;
        if (isId(tokens[k], 'as')) k += 2;
        if (isId(tokens[k], 'from') && tokens[k + 1]?.t === 'str') refs.push({ spec: tokens[k + 1].v, kind: 'reexport', line: token.line });
      } else if (isP(tokens[j], '{')) {
        const names = [];
        let k = j + 1;
        for (; k < tokens.length && !isP(tokens[k], '}'); k++) {
          if (tokens[k].t !== 'id') continue;
          if (isId(tokens[k], 'as') && tokens[k + 1]?.t === 'id') { names[names.length - 1] = { name: tokens[k + 1].v, line: tokens[k].line }; k++; continue; }
          names.push({ name: tokens[k].v, line: tokens[k].line });
        }
        if (isId(tokens[k + 1], 'from') && tokens[k + 2]?.t === 'str') refs.push({ spec: tokens[k + 2].v, kind: 'reexport', line: token.line });
        else for (const entry of names) if (entry.name !== 'default') exportsFound.push(entry);
      } else {
        let k = j;
        while (isId(tokens[k]) && MODIFIERS.has(tokens[k].v)) k++;
        if (isId(tokens[k]) && DECLARATIONS.has(tokens[k].v)) {
          k++;
          if (isP(tokens[k], '*')) k++;
          if (isId(tokens[k])) exportsFound.push({ name: tokens[k].v, line: tokens[k].line });
        }
      }
    } else if (token.v === 'require') {
      if (isP(next, '(')) {
        const spec = literal(tokens[i + 2]);
        if (spec !== null && isP(tokens[i + 3], ')')) refs.push({ spec, kind: 'require', line: token.line });
        else dynamic.push(token.line);
      } else if (isP(next, '.') && isId(tokens[i + 2], 'resolve') && isP(tokens[i + 3], '(')) {
        const spec = literal(tokens[i + 4]);
        if (spec !== null) refs.push({ spec, kind: 'require', line: token.line });
        else dynamic.push(token.line);
      } else if (isP(next, '.') && isId(tokens[i + 2], 'context')) dynamic.push(token.line);
    } else if (token.v === '__dirname') {
      const joined = dirnamePath(tokens, i + 1); // path.join(__dirname, 'cli', 'entry.js'), __dirname + '/x.js'
      if (joined) refs.push({ spec: `./${joined}`, kind: 'path', line: token.line, soft: true });
    } else if (token.v === 'URL' && isId(tokens[i - 1], 'new') && isP(next, '(')) {
      const spec = literal(tokens[i + 2]);
      if (spec !== null && isP(tokens[i + 3], ',') && isId(tokens[i + 4], 'import') && isP(tokens[i + 5], '.') && isId(tokens[i + 6], 'meta')) {
        refs.push({ spec, kind: 'url', line: token.line });
      }
    } else if ((token.v === 'jest' || token.v === 'vi' || token.v === 'vitest') && isP(next, '.') && MOCK_METHODS.has(tokens[i + 2]?.v) && isP(tokens[i + 3], '(')) {
      const spec = literal(tokens[i + 4]);
      if (spec !== null) refs.push({ spec, kind: 'mock', line: token.line });
    }
  }
  return { refs, dynamic, idents, exports: exportsFound };
}

/** Back-compatible helper: the module specifiers a source file loads, in source order. */
export function importedSpecifiers(source) {
  return extractModuleInfo(source).refs.map(ref => ref.spec);
}

/** Script text from Vue, Svelte, Astro and MDX files so their imports count. */
export function extractEmbeddedScripts(text, extension) {
  if (extension === '.mdx') return text;
  const blocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  if (extension === '.astro') {
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter) blocks.push(frontmatter[1]);
  }
  return blocks.join('\n');
}
