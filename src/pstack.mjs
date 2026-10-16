import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_PSTACK_CACHE = path.join(
  os.homedir(),
  '.codex',
  'plugins',
  'cache',
  'pstack-claude',
  'pstack',
);

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

  if (fs.existsSync(CODEX_PSTACK_CACHE)) {
    const versions = fs
      .readdirSync(CODEX_PSTACK_CACHE)
      .filter((name) => {
        try {
          return fs.statSync(path.join(CODEX_PSTACK_CACHE, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
    if (versions.length > 0) {
      const root = path.join(CODEX_PSTACK_CACHE, versions[0]);
      return { root, version: versions[0], skillsDir: path.join(root, 'skills') };
    }
  }

  throw new Error(
    'pstack not found. Install pstack-claude plugin or set PSTACK_ROOT to the pstack version directory (contains skills/).',
  );
}

export function pstackSkillDir(skillId) {
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
