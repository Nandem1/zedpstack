import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'fixtures');

/** Temp git repo + worker sheet + fake CLIs on PATH + fixture pstack. Mutates process.env. */
export function makeSandbox({ sheet = 'how explorer: haiku\narchitect runners: gpt-6.1-sol, composer-2.5\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.mjs'), 'export const x = 1;\n');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  const sheetPath = path.join(root, 'pstack-models.md');
  fs.writeFileSync(sheetPath, sheet);
  Object.assign(process.env, {
    PATH: `${path.join(FIXTURES, 'bin')}${path.delimiter}${process.env.PATH}`,
    PSTACK_ROOT: path.join(FIXTURES, 'pstack'),
    ZEDPSTACK_MODEL_SHEET: sheetPath,
    ZEDPSTACK_WORKTREES: path.join(root, 'worktrees'),
    // Keeps the user's probe cache out of expectedModel.
    ZEDPSTACK_HOME: path.join(root, 'zp-home'),
    TMPDIR: tmp,
  });
  const log = path.join(tmp, 'fake-cli.log');
  return {
    root,
    repo,
    sheetPath,
    cliCalls: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        : [],
  };
}
