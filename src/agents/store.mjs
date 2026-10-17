import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENTS_DIR } from '../constants.mjs';

export const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'stopped']);

export function agentsRoot(repoRoot) {
  return path.join(repoRoot, AGENTS_DIR);
}

export function agentDir(repoRoot, agentId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId ?? '')) {
    throw new Error(`invalid agent id: ${agentId}`);
  }
  return path.join(agentsRoot(repoRoot), agentId);
}

/** `.zedpstack/` ignores itself so runs never show up in the host repo's status. */
export function ensureStateDirIgnored(repoRoot) {
  const stateDir = path.join(repoRoot, '.zedpstack');
  fs.mkdirSync(stateDir, { recursive: true });
  const ignore = path.join(stateDir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8');
}

export function newAgentId(role) {
  const base = (role ?? 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'agent';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export function readAgent(repoRoot, agentId) {
  const file = path.join(agentDir(repoRoot, agentId), 'agent.json');
  if (!fs.existsSync(file)) {
    throw new Error(`agent not found: ${agentId}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeAgent(repoRoot, record) {
  const dir = agentDir(repoRoot, record.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return record;
}

/**
 * Read-modify-write. A terminal status is sticky so a late runner update cannot
 * overwrite `stopped`.
 */
export function updateAgent(repoRoot, agentId, patch) {
  const current = readAgent(repoRoot, agentId);
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  if (current.status === 'stopped' && next.status !== 'stopped') {
    next.status = 'stopped';
  }
  next.updatedAt = new Date().toISOString();
  return writeAgent(repoRoot, next);
}

export function listAgentIds(repoRoot) {
  const root = agentsRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, 'agent.json')));
}

export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
