/**
 * Code Cleaner: module graph, resolution and reachability (read-only).
 *
 * Builds an import graph for JS/TS (and Python) projects, including monorepos,
 * and classifies every module by how it is reached:
 *
 *   alive          reachable from an entry point (route, config, package entry,
 *                  script, file named in a manifest or Dockerfile, ...)
 *   candidate      nothing imports it
 *   deadChain      imported, but only by candidates / other dead code
 *   isolatedCycle  imported only by a closed group of modules nothing reaches
 *   testOnly       reached only from test files
 *
 * Counting incoming imports is not enough: two files that import each other
 * both have an importer, yet nothing reaches them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractModuleInfo, extractEmbeddedScripts } from './jslex.mjs';
import { compareText } from './lib.mjs';

const posix = path.posix;
export const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
export const SCRIPT_CONTAINERS = new Set(['.vue', '.svelte', '.astro', '.mdx']);
/** TypeScript ESM projects import "./x.js" while the file on disk is x.ts. */
const EXTENSION_SWAPS = { '.js': ['.ts', '.tsx', '.jsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
/** React Native / Expo / Metro pick Button.ios.tsx or Button.android.tsx for `import './Button'`. */
const PLATFORMS = ['ios', 'android', 'native', 'web', 'windows', 'macos'];
const PLATFORM_FILE = /^(.*)\.(?:ios|android|native|web|windows|macos)(\.[cm]?[jt]sx?)$/;
const RESOLVE_SUFFIXES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.css', '.scss', '.vue', '.svelte',
  ...PLATFORMS.flatMap(platform => ['.tsx', '.ts', '.jsx', '.js'].map(extension => `.${platform}${extension}`)),
];
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'lib']);
const EXPORT_CONDITIONS = ['import', 'default', 'require', 'node', 'module', 'types'];

/** Join POSIX path pieces; '' means the repository root. */
const join = (...parts) => {
  const pieces = parts.filter(part => part !== '');
  return pieces.length ? posix.normalize(posix.join(...pieces)).replace(/^\.$/, '').replace(/\/$/, '') : '';
};
const dirname = file => (posix.dirname(file) === '.' ? '' : posix.dirname(file));
export const dirnameOf = file => dirname(file);
export const ancestorsOf = dir => ancestors(dir);
const ancestors = dir => {
  const list = [];
  for (let current = dir; ; current = dirname(current)) { list.push(current); if (current === '') break; }
  return list;
};

/** JSON with comments and trailing commas (tsconfig style). Returns null if unreadable. */
export function readJsonLoose(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        out += char;
        if (char === '\\') out += text[++i] ?? '';
        else if (char === '"') inString = false;
      } else if (char === '"') { inString = true; out += char; }
      else if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
      else if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i === -1) break; i++; }
      else out += char;
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
  } catch { return null; }
}

// ------------------------------------------------------------------ resolver
export function createResolver({ allPaths, root }) {
  const jsonCache = new Map();
  const readJson = relative => {
    if (!jsonCache.has(relative)) jsonCache.set(relative, readJsonLoose(path.join(root, relative)));
    return jsonCache.get(relative);
  };

  // Every package.json that names itself is a workspace package, whether or not "workspaces" globs are parseable.
  const packages = new Map();
  for (const file of allPaths) {
    if (file === 'package.json' || !file.endsWith('/package.json') || packages.size >= 500) continue;
    const manifest = readJson(file);
    if (manifest && typeof manifest.name === 'string') packages.set(manifest.name, { dir: dirname(file), manifest });
  }
  const packageNames = [...packages.keys()].sort((a, b) => b.length - a.length);

  /** Resolve a base path to a real file: extension swaps, suffixes, index files, and dist -> src. */
  const findFile = (base, mapBuildOutput = true) => {
    if (base === undefined || base === null || base === '') return null;
    const extension = posix.extname(base);
    const swapped = (EXTENSION_SWAPS[extension] ?? []).map(next => base.slice(0, -extension.length) + next);
    const candidates = [base, ...swapped, ...RESOLVE_SUFFIXES.map(suffix => base + suffix), ...RESOLVE_SUFFIXES.map(suffix => `${base}/index${suffix}`)];
    const hit = candidates.find(candidate => allPaths.has(candidate));
    if (hit) return hit;
    if (mapBuildOutput) {
      const segments = base.split('/');
      const at = segments.findIndex(segment => BUILD_DIRS.has(segment));
      if (at >= 0) return findFile([...segments.slice(0, at), 'src', ...segments.slice(at + 1)].join('/'), false);
    }
    return null;
  };

  const configCache = new Map();
  /** tsconfig/jsconfig compilerOptions with `extends` followed; child baseUrl/paths replace the parent's, as TypeScript does. */
  const loadConfig = (configPath, depth = 0) => {
    if (configCache.has(configPath)) return configCache.get(configPath);
    let result = { baseUrl: null, paths: null, pathsDir: '' };
    configCache.set(configPath, result);
    const json = readJson(configPath);
    if (!json) return result;
    const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
    for (const parent of parents) {
      if (typeof parent !== 'string' || !parent.startsWith('.') || depth > 8) continue;
      let target = join(dirname(configPath), parent);
      if (!allPaths.has(target) && allPaths.has(`${target}.json`)) target += '.json';
      if (allPaths.has(target)) result = { ...loadConfig(target, depth + 1) };
    }
    const options = json.compilerOptions ?? {};
    const dir = dirname(configPath);
    if (typeof options.baseUrl === 'string') result.baseUrl = join(dir, options.baseUrl);
    if (options.paths && typeof options.paths === 'object') { result.paths = options.paths; result.pathsDir = dir; }
    configCache.set(configPath, result);
    return result;
  };
  const nearestCache = new Map();
  const nearestConfig = dir => {
    if (nearestCache.has(dir)) return nearestCache.get(dir);
    let found = null;
    for (const candidateDir of ancestors(dir)) {
      const hit = ['tsconfig.json', 'jsconfig.json'].map(name => join(candidateDir, name)).find(file => allPaths.has(file));
      if (hit) { found = loadConfig(hit); break; }
    }
    nearestCache.set(dir, found);
    return found;
  };

  const pick = value => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(pick).find(Boolean);
    if (value && typeof value === 'object') return EXPORT_CONDITIONS.map(key => pick(value[key])).find(Boolean) ?? pick(Object.values(value)[0]);
    return undefined;
  };

  const resolvePackage = ({ dir, manifest }, subpath) => {
    const exportsField = manifest.exports;
    if (subpath === '') {
      let target;
      if (exportsField !== undefined) {
        const subpathMap = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some(key => key.startsWith('.'));
        target = subpathMap ? pick(exportsField['.']) : pick(exportsField);
      }
      for (const candidate of [target, manifest.module, manifest.main, manifest.types, 'src/index', 'index']) {
        const hit = candidate ? findFile(join(dir, candidate)) : null;
        if (hit) return hit;
      }
      return null;
    }
    const key = `./${subpath}`;
    if (exportsField && typeof exportsField === 'object') {
      if (exportsField[key] !== undefined) {
        const hit = findFile(join(dir, pick(exportsField[key]) ?? ''));
        if (hit) return hit;
      }
      for (const [pattern, value] of Object.entries(exportsField)) {
        if (!pattern.includes('*')) continue;
        const [before, after] = pattern.split('*');
        if (!key.startsWith(before) || !key.endsWith(after) || key.length < before.length + after.length) continue;
        const target = pick(value);
        const hit = typeof target === 'string' ? findFile(join(dir, target.replace('*', key.slice(before.length, key.length - after.length)))) : null;
        if (hit) return hit;
      }
    }
    for (const candidate of [subpath, `src/${subpath}`]) {
      const hit = findFile(join(dir, candidate));
      if (hit) return hit;
    }
    return null;
  };

  /** { resolved, local }: `local` means the specifier points into this repo, so failing to resolve it is worth reporting. */
  const resolve = (importer, rawSpecifier) => {
    const specifier = rawSpecifier.replace(/[?#].*$/, '');
    if (!specifier || /^(?:node:|https?:|data:|\/\/)/.test(specifier)) return { resolved: null, local: false };
    const importerDir = dirname(importer);
    if (specifier.startsWith('.')) return { resolved: findFile(join(importerDir, specifier)), local: true };
    if (specifier.startsWith('/')) return { resolved: findFile(join(specifier.slice(1))), local: false };
    let local = false;
    const config = nearestConfig(importerDir);
    if (config?.paths) {
      const base = config.baseUrl ?? config.pathsDir;
      for (const [pattern, targets] of Object.entries(config.paths)) {
        const star = pattern.indexOf('*');
        let captured = null;
        if (star === -1) { if (specifier === pattern) captured = ''; }
        else {
          const before = pattern.slice(0, star);
          const after = pattern.slice(star + 1);
          if (specifier.startsWith(before) && specifier.endsWith(after) && specifier.length >= before.length + after.length) captured = specifier.slice(before.length, specifier.length - after.length);
        }
        if (captured === null) continue;
        local = true;
        for (const target of Array.isArray(targets) ? targets : []) {
          const hit = typeof target === 'string' ? findFile(join(base, target.replace('*', captured))) : null;
          if (hit) return { resolved: hit, local: true };
        }
      }
    }
    const name = packageNames.find(candidate => specifier === candidate || specifier.startsWith(`${candidate}/`));
    if (name) {
      local = true;
      const hit = resolvePackage(packages.get(name), specifier.slice(name.length + 1));
      if (hit) return { resolved: hit, local: true };
    }
    if (config?.baseUrl != null) {
      const hit = findFile(join(config.baseUrl, specifier));
      if (hit) return { resolved: hit, local: true };
    }
    // Conventional aliases when no tsconfig rule matched: @/ and ~/ (src or project root), $lib (SvelteKit).
    const alias = specifier.match(/^(?:[@~]\/|(\$lib)(?:\/|$))(.*)$/);
    if (alias) {
      local = true;
      for (const dir of ancestors(importerDir)) {
        for (const prefix of alias[1] ? ['src/lib'] : ['src', '']) {
          const hit = findFile(join(dir, prefix, alias[2]));
          if (hit) return { resolved: hit, local: true };
        }
      }
    }
    return { resolved: null, local };
  };

  /** Files named by package manifests (main, module, bin, types, exports), for the root package and every workspace package. */
  const entrypoints = rootManifest => {
    const found = new Set();
    const add = (dir, target) => {
      if (typeof target !== 'string') return;
      if (target.includes('*')) {
        const pattern = new RegExp(`^${join(dir, target).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        for (const file of allPaths) if (pattern.test(file)) found.add(file);
        return;
      }
      const hit = findFile(join(dir, target));
      if (hit) found.add(hit);
    };
    const walkValue = (dir, value) => {
      if (typeof value === 'string') add(dir, value);
      else if (Array.isArray(value)) value.forEach(entry => walkValue(dir, entry));
      else if (value && typeof value === 'object') Object.values(value).forEach(entry => walkValue(dir, entry));
    };
    const manifests = [{ dir: '', manifest: rootManifest }, ...packages.values()];
    for (const { dir, manifest } of manifests) {
      for (const field of ['main', 'module', 'types', 'typings', 'react-native', 'browser', 'bin', 'exports']) walkValue(dir, manifest[field]);
    }
    return found;
  };

  return { resolve, entrypoints, workspacePackages: packages.size };
}

// -------------------------------------------------------------------- python
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#;]+)/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm;
const PY_DYNAMIC = /\b(?:importlib\.import_module|__import__|pkgutil\.(?:iter_modules|walk_packages)|import_string)\s*\(/g;

export function pythonImports(text) {
  const refs = [];
  for (const match of text.matchAll(PY_IMPORT)) {
    for (const part of match[1].split(',')) {
      const module = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(module)) refs.push({ level: 0, module, names: [] });
    }
  }
  for (const match of text.matchAll(PY_FROM)) {
    const names = match[3].replace(/[()]/g, ' ').split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(name => /^\w+$/.test(name));
    refs.push({ level: match[1].length, module: match[2], names });
  }
  return refs;
}

export function pythonDynamicLines(text) {
  return [...text.matchAll(PY_DYNAMIC)].map(match => text.slice(0, match.index).split('\n').length);
}

function resolvePython(importer, ref, allPaths, rootName) {
  const importerDir = dirname(importer);
  let roots;
  if (ref.level > 0) {
    let base = importerDir;
    for (let i = 1; i < ref.level; i++) base = dirname(base);
    roots = [base];
  } else roots = ancestors(importerDir).flatMap(dir => [dir, join(dir, 'src')]);
  const parts = ref.module ? ref.module.split('.') : [];
  // Scanning the package folder itself: `from pip.x import y` refers to files directly under the scanned root.
  if (ref.level === 0 && rootName && parts[0] === rootName) {
    const stripped = resolvePython(importer, { ...ref, module: parts.slice(1).join('.') }, allPaths, null);
    if (stripped.length) return stripped;
  }
  for (const base of roots) {
    const found = new Set();
    const tryModule = pieces => {
      const target = join(base, ...pieces);
      for (const candidate of [`${target}.py`, join(target, '__init__.py')]) if (allPaths.has(candidate)) found.add(candidate);
    };
    if (parts.length) {
      tryModule(parts);
      for (let k = 1; k < parts.length; k++) { const init = join(base, ...parts.slice(0, k), '__init__.py'); if (allPaths.has(init)) found.add(init); }
    } else if (ref.level > 0 && allPaths.has(join(base, '__init__.py'))) found.add(join(base, '__init__.py'));
    for (const name of ref.names) tryModule([...parts, name]);
    if (found.size) return [...found];
  }
  return [];
}

// ------------------------------------------------------------------ analysis
/**
 * @param files      [{ path, text }] every scanned text file
 * @param allPaths   Set of every file path in the repository (for resolution)
 * @param isTest     path -> boolean
 * @param isAnchor   (path, text) -> boolean   entry points the project framework or tooling starts
 * @param isReferencedByConfig path -> boolean  named in a manifest, Dockerfile, CI file, ...
 * @param rootManifest parsed root package.json
 */
export function analyzeProject({ files, allPaths, root, isTest, isAnchor, isReferencedByConfig, rootManifest }) {
  const resolver = createResolver({ allPaths, root });
  const extensionOf = file => posix.extname(file);
  // Vue, Svelte, Astro and MDX files are modules too: a component nothing imports is dead code.
  const nodes = files.filter(file => JS_EXTENSIONS.has(extensionOf(file.path)) || SCRIPT_CONTAINERS.has(extensionOf(file.path)) || extensionOf(file.path) === '.py');
  const nodeSet = new Set(nodes.map(file => file.path));
  const edges = new Map();
  const incoming = new Map(nodes.map(file => [file.path, new Set()]));
  const reexports = new Map();
  const unresolved = new Set();
  const dynamicSites = [];
  const modules = new Map();
  let edgeCount = 0;

  // Platform variants of one module (Button.ios.tsx, Button.android.tsx) are all loaded by a single import.
  const variants = new Map();
  for (const file of nodes) {
    const match = file.path.match(PLATFORM_FILE);
    if (match) (variants.get(match[1] + match[2]) ?? variants.set(match[1] + match[2], []).get(match[1] + match[2])).push(file.path);
  }
  const siblingsOf = file => { const match = file.match(PLATFORM_FILE); return match ? variants.get(match[1] + match[2]) ?? [] : []; };

  const addEdge = (from, to, kind, viaSibling = false) => {
    if (from === to || !nodeSet.has(to)) return;
    if (!edges.has(from)) edges.set(from, new Set());
    if (!edges.get(from).has(to)) edgeCount++;
    edges.get(from).add(to);
    incoming.get(to).add(from);
    if (kind === 'reexport') {
      if (!reexports.has(from)) reexports.set(from, new Set());
      reexports.get(from).add(to);
    }
    if (!viaSibling) for (const sibling of siblingsOf(to)) addEdge(from, sibling, kind, true);
  };

  for (const file of nodes) {
    const extension = extensionOf(file.path);
    if (extension === '.py') {
      for (const ref of pythonImports(file.text)) for (const target of resolvePython(file.path, ref, allPaths, path.basename(root))) addEdge(file.path, target, 'import');
      for (const line of pythonDynamicLines(file.text)) dynamicSites.push(`${file.path}:${line}`);
      for (const match of file.text.matchAll(/['"]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)['"]/g)) {
        for (const target of resolvePython(file.path, { level: 0, module: match[1], names: [] }, allPaths, path.basename(root))) addEdge(file.path, target, 'import');
      }
      continue;
    }
    const source = SCRIPT_CONTAINERS.has(extension) ? extractEmbeddedScripts(file.text, extension) : file.text;
    const info = extractModuleInfo(source);
    modules.set(file.path, info);
    for (const ref of info.refs) {
      const { resolved, local } = resolver.resolve(file.path, ref.spec);
      if (resolved) addEdge(file.path, resolved, ref.kind);
      else if (local && !ref.soft) unresolved.add(`${file.path}: ${ref.spec}`);
    }
    for (const line of info.dynamic) dynamicSites.push(`${file.path}:${line}`);
  }

  const reach = starts => {
    const seen = new Set();
    const queue = [...starts];
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of edges.get(current) ?? []) if (!seen.has(next)) queue.push(next);
    }
    return seen;
  };

  const entrypoints = resolver.entrypoints(rootManifest ?? {});
  const anchors = new Set();
  for (const file of nodes) if (!isTest(file.path) && (entrypoints.has(file.path) || isAnchor(file.path, file.text))) anchors.add(file.path);
  let production = reach(anchors);

  // Files that no import reaches may still be started by a manifest, Dockerfile, CI step or scheduler.
  let rescuedByConfig = 0;
  for (const file of nodes) {
    if (production.has(file.path) || isTest(file.path)) continue;
    if (isReferencedByConfig(file.path)) { anchors.add(file.path); rescuedByConfig++; }
  }
  if (rescuedByConfig) production = reach(anchors);

  const candidates = [];
  const rest = [];
  for (const file of nodes) {
    if (production.has(file.path) || isTest(file.path) || /(?:^|\/)__init__\.py$/.test(file.path) || /\.d\.ts$/.test(file.path)) continue;
    (incoming.get(file.path).size === 0 ? candidates : rest).push(file.path);
  }
  const fromTests = reach(nodes.filter(file => isTest(file.path)).map(file => file.path));
  const fromCandidates = reach(candidates);
  const testOnly = [];
  const deadChains = [];
  const isolatedCycles = [];
  for (const file of rest) (fromTests.has(file) ? testOnly : fromCandidates.has(file) ? deadChains : isolatedCycles).push(file);

  // Why is a chain file listed? Name the zero-importer modules that reach it, so a reader can tell
  // a genuinely dead stub from a real entry point (a cron job, a CLI) the scanner could not recognise.
  const chainRoots = {};
  const chainSet = new Set(deadChains);
  for (const candidate of candidates.slice(0, 300)) {
    for (const file of reach([candidate])) {
      if (!chainSet.has(file)) continue;
      (chainRoots[file] ??= []).length < 3 && chainRoots[file].push(candidate);
    }
  }

  // Exports no other file mentions. Public API (package entry points and what they re-export) is exempt.
  const publicModules = new Set();
  const stack = [...entrypoints].filter(file => nodeSet.has(file));
  while (stack.length) {
    const current = stack.pop();
    if (publicModules.has(current)) continue;
    publicModules.add(current);
    for (const next of reexports.get(current) ?? []) stack.push(next);
  }
  const usage = new Map();
  for (const [file, info] of modules) for (const name of info.idents) {
    if (!usage.has(name)) usage.set(name, new Set());
    usage.get(name).add(file);
  }
  const unusedExports = [];
  for (const file of nodes) {
    const info = modules.get(file.path);
    if (!info || !JS_EXTENSIONS.has(extensionOf(file.path)) || !production.has(file.path) || anchors.has(file.path) || publicModules.has(file.path) || isTest(file.path)) continue;
    for (const entry of info.exports) {
      const users = usage.get(entry.name);
      if (!users || (users.size === 1 && users.has(file.path))) unusedExports.push({ path: file.path, name: entry.name, line: entry.line });
    }
  }
  unusedExports.sort((a, b) => compareText(a.path, b.path) || a.line - b.line);

  return {
    candidates: candidates.sort(compareText), deadChains: deadChains.sort(compareText), isolatedCycles: isolatedCycles.sort(compareText),
    testOnly: testOnly.sort(compareText), chainRoots, unusedExports, unresolved: [...unresolved].sort(compareText),
    dynamicSites, rescuedByConfig,
    stats: { modules: nodes.length, imports: edgeCount, entryPoints: anchors.size, workspacePackages: resolver.workspacePackages },
  };
}
