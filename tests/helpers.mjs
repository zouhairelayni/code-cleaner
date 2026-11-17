/** Shared fixtures for the Node tests (not a test file itself). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const scriptPath = name => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

/** Run a script as a user would, from the command line. */
export function runScript(name, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath(name), ...args], { encoding: 'utf8', ...options });
}

/** Create a throwaway project; `put(relativePath, text)` writes a file; the folder is always removed. */
export function inProject(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-cleaner-test-')));
  const put = (name, data = '') => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  try { return run({ root, put }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Content hash of every entry under root (symlinks recorded by target), to prove a script changed nothing. */
export function snapshot(root) {
  const entries = {};
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) entries[relative] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) { entries[relative] = 'dir'; visit(full); }
      else entries[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(root);
  return entries;
}

export const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
