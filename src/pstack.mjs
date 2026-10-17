import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Plugin caches that hold `<version>/skills/` for pstack, newest wins per cache. */
function pstackCacheDirs() {
  const home = os.homedir();
  const dirs = [path.join(home, '.codex', 'plugins', 'cache', 'pstack-claude', 'pstack')];
  const claudeCache = path.join(home, '.claude', 'plugins', 'cache');
  if (fs.existsSync(claudeCache)) {
    for (const marketplace of fs.readdirSync(claudeCache)) {
      dirs.push(path.join(claudeCache, marketplace, 'pstack'));
    }
  }
  return dirs.filter((d) => fs.existsSync(d));
}

/** @returns {number} positive if b > a (sort descending) */
export function comparePstackVersions(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Raíz de una instalación pstack (directorio que contiene `skills/`).
 * @returns {{ root: string, version: string | null, skillsDir: string }}
 */
export function resolvePstackInstall() {
  const explicit = process.env.PSTACK_ROOT;
  if (explicit) {
    const root = path.resolve(explicit);
    const skillsDir = fs.existsSync(path.join(root, 'skills'))
      ? path.join(root, 'skills')
      : root;
    const version = path.basename(root);
    return { root, version, skillsDir };
  }

  const found = [];
  for (const cache of pstackCacheDirs()) {
    for (const name of fs.readdirSync(cache)) {
      if (fs.existsSync(path.join(cache, name, 'skills'))) {
        found.push({ root: path.join(cache, name), version: name });
      }
    }
  }
  found.sort((a, b) => comparePstackVersions(a.version, b.version));
  if (found.length > 0) {
    const { root, version } = found[0];
    return { root, version, skillsDir: path.join(root, 'skills') };
  }

  throw new Error(
    'pstack not found. Install pstack-claude plugin or set PSTACK_ROOT to the pstack version directory (contains skills/).',
  );
}

export function pstackSkillDir(skillId) {
  assertSkillId(skillId);
  const { skillsDir } = resolvePstackInstall();
  const dir = path.join(skillsDir, skillId);
  if (!fs.existsSync(dir)) {
    throw new Error(`pstack skill not found: ${skillId} (${dir})`);
  }
  return dir;
}

export function readPstackFile(...segments) {
  const filePath = path.join(...segments);
  if (!fs.existsSync(filePath)) {
    throw new Error(`pstack file missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** Skill ids are directory names under skills/; reject anything path-like. */
function assertSkillId(skillId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId ?? '')) {
    throw new Error(`invalid pstack skill id: ${skillId}`);
  }
}

export function listPstackSkills() {
  const { skillsDir } = resolvePstackInstall();
  return fs
    .readdirSync(skillsDir)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    .sort();
}

/**
 * Read a file inside one pstack skill (default SKILL.md). Paths stay inside the
 * skill directory.
 */
export function readPstackSkillFile(skillId, relativeFile = 'SKILL.md') {
  const dir = pstackSkillDir(skillId);
  const filePath = path.resolve(dir, relativeFile);
  if (filePath !== dir && !filePath.startsWith(`${dir}${path.sep}`)) {
    throw new Error(`path escapes skill directory: ${relativeFile}`);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`pstack file missing: ${skillId}/${relativeFile}`);
  }
  return { path: filePath, text: fs.readFileSync(filePath, 'utf8') };
}
