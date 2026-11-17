/**
 * Code Cleaner: helpers shared by scan.mjs and gate.mjs.
 *
 * Everything here is read-only and dependency-free (Node >= 18). It never
 * touches the network and never spawns processes. The one thing the scripts
 * must get right is *not lying*: when a file, folder or scope could not be
 * searched, callers need to know so they never report a clean result they did
 * not earn. `walk` and `readTextFile` therefore report what they skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '2.1.0';

/** Dependency, VCS and cache folders. Never project source: skipped at any depth. */
export const SKIP_ANYWHERE = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', 'Pods',
  '.gradle', '.cache', '.turbo', '.pytest_cache', '.mypy_cache',
]);

/**
 * Build output. Skipped only at the repository root, so real source folders
 * such as `src/build/` or `lib/out/` are still searched.
 */
export const SKIP_AT_ROOT = new Set([
  'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  '.next', '.nuxt', '.expo', '.svelte-kit', '.output', '.parcel-cache',
]);

/** Extensions that are never worth reading as text. */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.heic', '.avif',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.aar', '.apk', '.aab',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg',
  '.so', '.dylib', '.dll', '.exe', '.class', '.o', '.a', '.wasm', '.keystore', '.jks', '.pyc',
  '.sqlite', '.db', '.lockb',
]);

/** Code-point comparison: `localeCompare` would make output depend on the machine's locale. */
export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve the root to a real directory. Throws a readable error otherwise.
 * Returning the real path means later "is this inside the root" checks cannot
 * be fooled by a symlinked root.
 */
export function ensureRoot(root) {
  let real;
  try { real = fs.realpathSync(root); }
  catch { throw new Error(`Root does not exist or is unreadable: ${root}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Root must be a directory: ${root}`);
  return real;
}

/**
 * Walk a repository without following symlinks.
 * Returns every regular file (relative POSIX path) plus a record of what was
 * deliberately or accidentally left out.
 */
export function walk(root) {
  const files = [];
  const skippedDirs = [];
  const unreadableDirs = [];
  let symlinks = 0;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(relDir ? path.join(root, relDir) : root, { withFileTypes: true }); }
    catch { unreadableDirs.push(relDir || '.'); continue; }
    for (const entry of entries) {
      const relative = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { symlinks++; continue; }
      if (entry.isDirectory()) {
        if (SKIP_ANYWHERE.has(entry.name) || (relDir === '' && SKIP_AT_ROOT.has(entry.name))) skippedDirs.push(relative);
        else stack.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ relative, absolute: path.join(root, relative), ext: path.extname(entry.name).toLowerCase() });
    }
  }
  files.sort((a, b) => compareText(a.relative, b.relative));
  skippedDirs.sort(compareText);
  unreadableDirs.sort(compareText);
  return { files, skippedDirs, unreadableDirs, symlinks };
}

/**
 * Read one file as text. The status says why a file was not read so callers
 * can report it: 'large', 'binary' or 'unreadable'.
 */
export function readTextFile(file, maxBytes) {
  try {
    const { size } = fs.statSync(file.absolute);
    if (size > maxBytes) return { status: 'large', size };
    const bytes = fs.readFileSync(file.absolute);
    if (bytes.subarray(0, 8000).includes(0)) return { status: 'binary' };
    return { status: 'ok', bytes, text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Turn a user-supplied path into a normalized POSIX path relative to the root.
 * '' means the whole root. Throws for absolute paths and for anything that
 * climbs out of the root ("../x", "a/../../x").
 */
export function normalizeRelative(input) {
  if (typeof input !== 'string' || input === '') throw new Error('Path must be a non-empty string');
  if (input.includes('\0')) throw new Error('Path contains a NUL byte');
  const slashed = input.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) {
    throw new Error(`Path must be relative to the root: ${input}`);
  }
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Path must stay inside the root: ${input}`);
  return normalized === '.' ? '' : normalized;
}

/** True when `file` is `prefix` or lives under it. The empty prefix is the whole root. */
export function overlaps(file, prefix) {
  return prefix === '' || file === prefix || file.startsWith(`${prefix}/`);
}

/**
 * True if something exists at root/relative, without following a final symlink
 * (so a dangling symlink counts as existing). Throws if the parent directory
 * resolves outside the root, because then the answer would be about a
 * different tree.
 */
export function existsNoFollow(root, relative) {
  const absolute = path.join(root, relative);
  let parent;
  try { parent = fs.realpathSync(path.dirname(absolute)); }
  catch { return false; }
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`Path resolves outside the root: ${relative}`);
  try { fs.lstatSync(absolute); return true; }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * --scope / --exclude accept a path prefix (src/legacy) or a simple glob
 * (**\/*.md, *.lock, android/**). Globs follow gitignore intuition: a pattern
 * without a slash matches the file name at any depth; ** crosses folders, *
 * and ? do not.
 */
export function pathMatcher(input) {
  if (!/[*?]/.test(input)) {
    const prefix = normalizeRelative(input);
    return { text: input, test: file => overlaps(file, prefix), glob: false, prefix };
  }
  const normalized = input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`Glob must stay inside the root: ${input}`);
  const body = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  const anchored = normalized.includes('/');
  const expression = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
  return { text: input, test: file => expression.test(file), glob: true, prefix: null };
}


/**
 * Make repository-derived text safe to print into a report that an agent or a
 * terminal will read: control characters, bidi overrides and backticks are
 * replaced and long values are truncated. Repository content is untrusted;
 * this stops it from forging report structure, but it cannot make a hostile
 * file name harmless, so reports must still be read as data, not instructions.
 */
export function clean(value, max = 200) {
  if (!Number.isInteger(max) || max < 10) max = 200; // guards against `array.map(clean)` passing the index as the limit
  const text = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?')
    .replace(/`/g, "'");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Best-effort removal of credentials from strings copied out of source code. */
export function redactSecrets(value) {
  return String(value)
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@')
    .replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g, '<redacted>')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{12,}/g, '<redacted>')
    .replace(/[A-Za-z0-9_-]{32,}/g, run => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '<redacted>' : run));
}

/**
 * Tiny, strict command-line parser shared by both scripts.
 * spec maps a flag to { key, kind: 'value' | 'multi' | 'bool' }.
 * Supports `--flag value` and `--flag=value`. Returns null when help is asked.
 * A value that looks like another known flag is reported as "missing value"
 * instead of being swallowed silently (`--root --format md`).
 */
export function parseFlags(argv, spec, defaults) {
  const options = structuredClone(defaults);
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    if (flag === '--help' || flag === '-h') return null;
    let inline;
    const equals = flag.indexOf('=');
    if (flag.startsWith('--') && equals > 2) { inline = flag.slice(equals + 1); flag = flag.slice(0, equals); }
    const rule = spec[flag];
    if (!rule) throw new Error(flag.startsWith('-') ? `Unknown option ${flag}. Use --help.` : `Unexpected argument ${flag}. Use --help.`);
    if (rule.kind === 'bool') { options[rule.key] = true; continue; }
    let value = inline;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value === '' || spec[value]) throw new Error(`Missing value for ${flag}`);
    }
    if (inline === '') throw new Error(`Missing value for ${flag}`);
    if (rule.kind === 'multi') options[rule.key].push(value);
    else options[rule.key] = value;
  }
  return options;
}

/**
 * True when the current file is the script being executed. Uses real paths so
 * running through a symlink (npm bin, ~/bin links) still works; a plain
 * path comparison silently does nothing in that case.
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl)); }
  catch { return false; }
}
