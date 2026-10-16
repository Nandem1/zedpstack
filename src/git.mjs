import { spawnSync } from 'node:child_process';

export function tryGitCommit(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (r.status === 0) {
    return r.stdout.trim();
  }
  return null;
}
