import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../hash.mjs';

export function git(cwd, args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  return { ok: res.status === 0, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

export function isGitRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).stdout === 'true';
}

/** Worktrees live outside the repo so the host repo never sees them as untracked files. */
export function worktreesRoot(repoRoot) {
  const top = git(repoRoot, ['rev-parse', '--show-toplevel']).stdout;
  const slug = `${path.basename(top)}-${sha256Hex(top).slice(0, 8)}`;
  return path.join(process.env.ZEDPSTACK_WORKTREES ?? path.join(os.homedir(), '.zedpstack', 'worktrees'), slug);
}

export function createAgentWorktree(repoRoot, agentId, base = 'HEAD') {
  const baseCommit = git(repoRoot, ['rev-parse', base]).stdout;
  const branch = `zedpstack/${agentId}`;
  const wtPath = path.join(worktreesRoot(repoRoot), agentId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, baseCommit]);
  const dirty = git(repoRoot, ['status', '--porcelain'], { allowFail: true }).stdout;
  return { path: wtPath, branch, baseCommit, hostHadUncommittedChanges: dirty.length > 0 };
}

/**
 * Commit whatever the worker left in its worktree, so the result is one
 * reviewable commit on the agent branch.
 */
export function snapshotWorktree(worktree, message) {
  git(worktree.path, ['add', '-A']);
  const staged = git(worktree.path, ['diff', '--cached', '--name-status']).stdout;
  let commit = null;
  if (staged) {
    git(worktree.path, [
      '-c', 'user.name=zedpstack',
      '-c', 'user.email=zedpstack@localhost',
      'commit', '-q', '--no-verify', '-m', message,
    ]);
  }
  const head = git(worktree.path, ['rev-parse', 'HEAD']).stdout;
  if (head !== worktree.baseCommit) commit = head;
  const range = `${worktree.baseCommit}..${head}`;
  return {
    commit,
    branch: worktree.branch,
    files: commit ? git(worktree.path, ['diff', '--name-status', range]).stdout.split('\n').filter(Boolean) : [],
    diffStat: commit ? git(worktree.path, ['diff', '--stat', range]).stdout : '',
  };
}

/** Bring an agent commit into the host working tree, uncommitted, for review. */
export function applyAgentCommit(repoRoot, commit) {
  const res = git(repoRoot, ['cherry-pick', '--no-commit', commit], { allowFail: true });
  if (!res.ok) {
    git(repoRoot, ['cherry-pick', '--abort'], { allowFail: true });
    return { applied: false, error: res.stderr || res.stdout };
  }
  return { applied: true, status: git(repoRoot, ['status', '--short']).stdout };
}

export function removeAgentWorktree(repoRoot, worktree, { deleteBranch = false } = {}) {
  git(repoRoot, ['worktree', 'remove', '--force', worktree.path], { allowFail: true });
  if (deleteBranch) git(repoRoot, ['branch', '-D', worktree.branch], { allowFail: true });
  return { removed: !fs.existsSync(worktree.path), branchDeleted: deleteBranch };
}

export function workingTreeChanges(dir) {
  if (!isGitRepo(dir)) return null;
  return git(dir, ['status', '--short'], { allowFail: true }).stdout.split('\n').filter(Boolean);
}
