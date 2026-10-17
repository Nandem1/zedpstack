import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENTS_DIR } from '../constants.mjs';

/**
 * One writer per file, so no record is ever read-modified-written:
 *
 *   agent.json    AgentSpec, created once by spawnAgent, never rewritten
 *   launch.json   { runnerPid }, created once by spawnAgent
 *   run.json      RunState, replaced whole by the runner process only
 *   stop.json     { requestedAt, by }, created once by stopAgent
 *   cleanup.json  { removedAt, branchDeleted }, created once by closeAgent
 *
 * Status is derived when reading (`deriveStatus`); readers never write.
 */

export const SPEC_VERSION = 2;
export const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'stopped']);
export const START_GRACE_MS = 15_000;
export const STOPPED_ERROR = 'stopped by orchestrator';
export const RUNNER_LOST_ERROR = 'runner process exited without finishing (see runner.log)';

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

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Exclusive create that readers never see half-written: a plain `wx` write is
 * visible while it is still being filled, a hard link appears whole or not at all.
 * Returns false when the file already exists.
 */
function createOnce(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, json(value), { encoding: 'utf8', flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const file = (repoRoot, id, name) => path.join(agentDir(repoRoot, id), name);

export function createSpec(repoRoot, spec) {
  const record = { version: SPEC_VERSION, ...spec };
  if (!createOnce(file(repoRoot, record.id, 'agent.json'), record)) {
    throw new Error(`agent already exists: ${record.id}`);
  }
  return record;
}

export function writeLaunch(repoRoot, id, launch) {
  if (!createOnce(file(repoRoot, id, 'launch.json'), launch)) {
    throw new Error(`agent ${id} was already launched`);
  }
  return launch;
}

/** Only the runner process calls this, so a whole-file replace loses nothing. */
export function writeRun(repoRoot, id, run) {
  const target = file(repoRoot, id, 'run.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json(run), 'utf8');
  fs.renameSync(tmp, target);
  return run;
}

/** Idempotent: the first stop wins and later calls return it with `created: false`. */
export function markStop(repoRoot, id, by) {
  const target = file(repoRoot, id, 'stop.json');
  const created = createOnce(target, { requestedAt: new Date().toISOString(), by: by ?? null });
  return { stop: readJson(target), created };
}

export function markCleanup(repoRoot, id, { branchDeleted }) {
  const target = file(repoRoot, id, 'cleanup.json');
  const created = createOnce(target, { removedAt: new Date().toISOString(), branchDeleted: Boolean(branchDeleted) });
  return { cleanup: readJson(target), created };
}

/** Pure. `stop` is sticky: it wins over an outcome the runner writes after it. */
export function deriveStatus(spec, run, launch, stop, runnerAlive, nowMs) {
  if (stop) return 'stopped';
  if (run?.outcome) return run.outcome.ok ? 'completed' : 'failed';
  if (!run) {
    return runnerAlive || nowMs - Date.parse(spec.createdAt) < START_GRACE_MS ? 'starting' : 'failed';
  }
  return runnerAlive ? 'running' : 'failed';
}

/** A v1 record kept every field in one `agent.json` with a stored `status`. */
function fromV1(record) {
  const { status } = record;
  const binding = { runtime: record.runtime, model: record.model, permissionProfile: record.permissionProfile };
  if (record.effort) binding.effort = record.effort;
  const spec = {
    version: 1,
    id: record.id,
    binding,
    role: record.role ?? null,
    slot: record.slot ?? 0,
    modelSource: record.modelSource ?? null,
    subagentType: record.subagentType ?? null,
    skills: record.skills ?? [],
    cliVersion: record.cliVersion ?? null,
    description: record.description ?? null,
    repoRoot: record.repoRoot,
    cwd: record.cwd,
    isolation: record.isolation,
    worktree: record.worktree ?? null,
    timeoutMs: record.timeoutMs ?? null,
    notes: record.notes ?? [],
    createdAt: record.createdAt,
    origin: null,
    expectedModel: null,
  };
  const finished = status === 'completed' || status === 'failed';
  const run = status === 'starting'
    ? null
    : {
        runnerPid: record.runnerPid ?? null,
        workerPid: record.workerPid ?? null,
        startedAt: record.startedAt ?? null,
        effectiveModel: record.effectiveModel ?? null,
        outcome: finished
          ? {
              ok: status === 'completed',
              exitCode: record.exitCode ?? null,
              timedOut: record.timedOut ?? false,
              error: record.error ?? null,
              changes: record.changes ?? null,
              changeError: record.changeError ?? null,
              finishedAt: record.finishedAt ?? null,
            }
          : null,
      };
  return {
    spec,
    run,
    launch: record.runnerPid ? { runnerPid: record.runnerPid } : null,
    stop: status === 'stopped' ? { requestedAt: record.finishedAt ?? record.updatedAt ?? null, by: 'v1' } : null,
    cleanup: record.worktreeRemoved ? { removedAt: record.updatedAt ?? null, branchDeleted: null } : null,
  };
}

/**
 * Merged AgentView `{spec, run, launch, stop, cleanup, status, error, finishedAt}`.
 * `error` and `finishedAt` are derived alongside `status` so callers never
 * re-branch on which file decided it.
 */
export function loadAgent(repoRoot, id, nowMs = Date.now()) {
  const dir = agentDir(repoRoot, id);
  const raw = readJson(path.join(dir, 'agent.json'));
  if (!raw) throw new Error(`agent not found: ${id}`);
  const legacy = raw.version !== SPEC_VERSION ? fromV1(raw) : null;
  const spec = legacy?.spec ?? raw;
  const run = readJson(path.join(dir, 'run.json')) ?? legacy?.run ?? null;
  const launch = readJson(path.join(dir, 'launch.json')) ?? legacy?.launch ?? null;
  const stop = readJson(path.join(dir, 'stop.json')) ?? legacy?.stop ?? null;
  const cleanup = readJson(path.join(dir, 'cleanup.json')) ?? legacy?.cleanup ?? null;
  const runnerAlive = isProcessAlive(run?.runnerPid ?? launch?.runnerPid);
  const status = deriveStatus(spec, run, launch, stop, runnerAlive, nowMs);
  let error = null;
  let finishedAt = null;
  if (status === 'stopped') {
    error = STOPPED_ERROR;
    finishedAt = stop.requestedAt;
  } else if (run?.outcome) {
    error = run.outcome.error ?? null;
    finishedAt = run.outcome.finishedAt ?? null;
  } else if (status === 'failed') {
    error = RUNNER_LOST_ERROR;
  }
  return { spec, run, launch, stop, cleanup, status, error, finishedAt };
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
