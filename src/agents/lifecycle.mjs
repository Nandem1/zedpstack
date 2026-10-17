import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { AGENT_RECORD_VERSION, DEFAULT_AGENT_TIMEOUT_MS } from '../constants.mjs';
import { EventSink } from '../events/sink.mjs';
import { dispatchScriptPath } from '../paths.mjs';
import { verifyRuntimeAvailable } from '../permissions.mjs';
import { resolvePstackInstall } from '../pstack.mjs';
import { runWorkerProcess } from '../runtimes/worker.mjs';
import { resolveAgentModel } from '../workerModels.mjs';
import { boardRows } from './board.mjs';
import {
  buildAgentPrompt,
  effortFromSubagentType,
  normalizeSubagentType,
} from './prompt.mjs';
import {
  TERMINAL_AGENT_STATUSES,
  agentDir,
  ensureStateDirIgnored,
  isProcessAlive,
  listAgentIds,
  newAgentId,
  readAgent,
  updateAgent,
  writeAgent,
} from './store.mjs';
import {
  applyAgentCommit,
  createAgentWorktree,
  isGitRepo,
  removeAgentWorktree,
  snapshotWorktree,
  workingTreeChanges,
} from './worktree.mjs';

const MAX_INLINE_RESULT_CHARS = 60_000;

function resolveRepo(repo) {
  const repoRoot = path.resolve(repo ?? process.cwd());
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`repo is not a directory: ${repoRoot}`);
  }
  return repoRoot;
}

function configData() {
  try {
    return loadConfig().data;
  } catch {
    return {};
  }
}

/**
 * Start one worker in the background and return its record at once.
 *
 * Fields mirror pstack's `Agent` dispatch (`prompt`, `description`,
 * `subagent_type`, `model`, `readonly`) plus zedpstack routing (`role`, `slot`,
 * `runtime`, `effort`, `isolation`, `skills`).
 */
export function spawnAgent(req) {
  if (!req?.prompt || !String(req.prompt).trim()) {
    throw new Error('spawn_agent requires a non-empty prompt');
  }
  const repoRoot = resolveRepo(req.repo);
  const subagentType = normalizeSubagentType(req.subagent_type);
  const typeEffort = effortFromSubagentType(req.subagent_type);
  const resolved = resolveAgentModel({
    role: req.role,
    slot: req.slot,
    model: req.model,
    runtime: req.runtime,
    effort: req.effort ?? typeEffort ?? undefined,
  });
  const binding = {
    runtime: resolved.runtime,
    model: resolved.model,
    permissionProfile: req.readonly === true ? 'read-only' : 'workspace-write',
  };
  const notes = [...resolved.notes];
  if (resolved.effort) {
    if (binding.runtime === 'cursor') {
      notes.push(`Cursor CLI has no effort flag; effort "${resolved.effort}" ignored`);
    } else if (binding.runtime === 'codex' && resolved.effort === 'max') {
      binding.effort = 'xhigh';
      notes.push('Codex has no "max" effort; using "xhigh"');
    } else {
      binding.effort = resolved.effort;
    }
  }
  const cliVersion = verifyRuntimeAvailable(binding);

  const readonly = binding.permissionProfile === 'read-only';
  let isolation = req.isolation ?? (readonly ? 'none' : 'worktree');
  if (isolation === 'worktree' && !isGitRepo(repoRoot)) {
    notes.push('repo is not a git repository; the writer runs in place (isolation "none")');
    isolation = 'none';
  }

  ensureStateDirIgnored(repoRoot);
  const id = newAgentId(req.role ?? req.description ?? subagentType);
  const dir = agentDir(repoRoot, id);
  fs.mkdirSync(dir, { recursive: true });

  let worktree = null;
  if (isolation === 'worktree') {
    worktree = createAgentWorktree(repoRoot, id, req.base ?? 'HEAD');
    if (worktree.hostHadUncommittedChanges) {
      notes.push('the host repo has uncommitted changes; the worktree starts from the last commit and does not see them');
    }
  }
  const cwd = worktree?.path ?? repoRoot;

  const promptText = buildAgentPrompt({
    task: String(req.prompt),
    subagentType,
    skills: req.skills ?? [],
    readonly,
    cwd,
    worktree,
    role: req.role ?? null,
    runtime: binding.runtime,
    model: binding.model,
  });
  fs.writeFileSync(path.join(dir, 'task.md'), String(req.prompt), 'utf8');
  fs.writeFileSync(path.join(dir, 'prompt.md'), promptText, 'utf8');

  const now = new Date().toISOString();
  const record = writeAgent(repoRoot, {
    version: AGENT_RECORD_VERSION,
    id,
    description: req.description ?? null,
    role: resolved.role,
    slot: req.slot ?? 0,
    modelSource: resolved.source,
    subagentType,
    skills: req.skills ?? [],
    ...binding,
    cliVersion,
    repoRoot,
    cwd,
    isolation,
    worktree,
    timeoutMs: req.timeout_seconds ? req.timeout_seconds * 1000 : DEFAULT_AGENT_TIMEOUT_MS,
    notes,
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    runnerPid: null,
    workerPid: null,
  });

  const runnerLog = fs.openSync(path.join(dir, 'runner.log'), 'a');
  const runner = spawn(
    process.execPath,
    [dispatchScriptPath(), 'agent', 'exec', '--repo', repoRoot, '--id', id],
    { detached: true, stdio: ['ignore', runnerLog, runnerLog], cwd: repoRoot, env: process.env },
  );
  runner.unref();
  fs.closeSync(runnerLog);
  return summarize(updateAgent(repoRoot, id, { runnerPid: runner.pid }));
}

/** Body of the detached runner process (`dispatch agent exec`). */
export async function execAgent({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const record = updateAgent(repoRoot, id, {
    status: 'running',
    runnerPid: process.pid,
    startedAt: new Date().toISOString(),
  });
  if (record.status === 'stopped') return record;
  const dir = agentDir(repoRoot, id);
  const sink = new EventSink(dir, { humanProgress: false });
  const extraReadDirs = [];
  try {
    extraReadDirs.push(resolvePstackInstall().skillsDir);
  } catch {
    // no pstack: workers that were told to read skills will report it
  }
  if (record.worktree) extraReadDirs.push(repoRoot);

  let outcome;
  try {
    outcome = await runWorkerProcess({
      binding: {
        runtime: record.runtime,
        model: record.model,
        permissionProfile: record.permissionProfile,
        effort: record.effort,
      },
      cwd: record.cwd,
      promptText: fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
      workerRoot: dir,
      timeoutMs: record.timeoutMs,
      emit: (type, payload) => sink.emit(type, payload),
      eventBase: { agentId: id, role: record.role ?? record.subagentType },
      extraReadDirs,
      allowedTools: configData().permissions?.claudeWriteAllowedTools,
      onSpawned: ({ pid }) => updateAgent(repoRoot, id, { workerPid: pid }),
      onMeta: ({ effectiveModel }) => updateAgent(repoRoot, id, { effectiveModel }),
    });
  } catch (err) {
    sink.emit('worker.failed', { agentId: id, reason: err.message });
    return updateAgent(repoRoot, id, {
      status: 'failed',
      error: err.message,
      finishedAt: new Date().toISOString(),
    });
  }

  let changes = null;
  let changeError = null;
  try {
    if (record.worktree) {
      changes = snapshotWorktree(record.worktree, `zedpstack ${id}: ${record.description ?? record.role ?? 'agent'}`);
    } else if (record.permissionProfile === 'workspace-write') {
      changes = { inPlace: true, status: workingTreeChanges(record.cwd) };
    }
  } catch (err) {
    changeError = err.message;
  }

  const { result } = outcome;
  if (changes?.commit && !result.ok) changes.partial = true;
  return updateAgent(repoRoot, id, {
    status: result.ok ? 'completed' : 'failed',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    error: result.ok ? null : outcome.timedOut ? 'timeout' : `exit ${outcome.exitCode}${result.text === '(empty)' ? ', empty output' : ''}`,
    changes,
    changeError,
    finishedAt: new Date().toISOString(),
  });
}

/** Mark a record whose runner vanished without finishing. */
function reconcile(repoRoot, record) {
  if (TERMINAL_AGENT_STATUSES.has(record.status)) return record;
  const graceMs = 15_000;
  const young = Date.now() - Date.parse(record.createdAt) < graceMs;
  if (isProcessAlive(record.runnerPid) || (record.status === 'starting' && young)) return record;
  return updateAgent(repoRoot, record.id, {
    status: 'failed',
    error: 'runner process exited without finishing (see runner.log)',
    finishedAt: new Date().toISOString(),
  });
}

function tailLines(file, n) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n);
}

function summarize(record) {
  const out = {
    agent_id: record.id,
    status: record.status,
    description: record.description,
    role: record.role,
    runtime: record.runtime,
    model: record.model,
    effort: record.effort ?? null,
    readonly: record.permissionProfile === 'read-only',
    isolation: record.isolation,
    cwd: record.cwd,
    created_at: record.createdAt,
    finished_at: record.finishedAt ?? null,
  };
  if (record.error) out.error = record.error;
  if (record.notes?.length) out.notes = record.notes;
  if (record.worktree) out.branch = record.worktree.branch;
  if (record.effectiveModel) out.effective_model = record.effectiveModel;
  return out;
}

export function agentStatus({ repo, id, tail = 8 }) {
  const repoRoot = resolveRepo(repo);
  const record = reconcile(repoRoot, readAgent(repoRoot, id));
  return {
    ...summarize(record),
    progress: tailLines(path.join(agentDir(repoRoot, id), 'progress.log'), tail),
  };
}

export function agentResult({ repo, id, maxChars = MAX_INLINE_RESULT_CHARS }) {
  const repoRoot = resolveRepo(repo);
  const record = reconcile(repoRoot, readAgent(repoRoot, id));
  const dir = agentDir(repoRoot, id);
  const resultPath = path.join(dir, 'result.json');
  const out = { ...summarize(record) };
  if (!TERMINAL_AGENT_STATUSES.has(record.status)) {
    out.text = null;
    out.progress = tailLines(path.join(dir, 'progress.log'), 8);
    return out;
  }
  let text = '';
  if (fs.existsSync(resultPath)) {
    text = JSON.parse(fs.readFileSync(resultPath, 'utf8')).text ?? '';
  }
  out.text = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated; full text in ${resultPath}]` : text;
  out.result_path = resultPath;
  if (record.changes) out.changes = record.changes;
  if (record.changeError) out.change_error = record.changeError;
  if (record.status === 'failed') {
    out.stderr_tail = tailLines(path.join(dir, 'stderr.log'), 15);
  }
  return out;
}

/**
 * Block until the agents finish (`mode: all`) or one finishes (`mode: any`),
 * or until the timeout. Finished agents come back with their result text.
 */
export async function waitAgents({ repo, ids, timeoutSeconds = 50, mode = 'all', pollMs = 500, onTick }) {
  const repoRoot = resolveRepo(repo);
  const targets = ids?.length
    ? ids
    : listAgentIds(repoRoot).filter((id) => !TERMINAL_AGENT_STATUSES.has(readAgent(repoRoot, id).status));
  const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
  for (;;) {
    const records = targets.map((id) => reconcile(repoRoot, readAgent(repoRoot, id)));
    const done = records.filter((r) => TERMINAL_AGENT_STATUSES.has(r.status));
    onTick?.({ records, done: done.length, total: records.length, rows: boardRows(repoRoot, records) });
    const finished = mode === 'any' ? done.length > 0 : done.length === records.length;
    if (finished || Date.now() >= deadline) {
      return {
        timed_out: !finished,
        done: done.map((r) => agentResult({ repo: repoRoot, id: r.id })),
        pending: records
          .filter((r) => !TERMINAL_AGENT_STATUSES.has(r.status))
          .map((r) => agentStatus({ repo: repoRoot, id: r.id, tail: 3 })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function stopAgent({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const record = readAgent(repoRoot, id);
  if (TERMINAL_AGENT_STATUSES.has(record.status)) return summarize(record);
  updateAgent(repoRoot, id, { status: 'stopped', finishedAt: new Date().toISOString(), error: 'stopped by orchestrator' });
  const signalAll = (signal) => {
    for (const pid of [record.workerPid, record.runnerPid]) {
      if (!isProcessAlive(pid)) continue;
      try {
        process.kill(pid === record.runnerPid ? -pid : pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // gone
        }
      }
    }
  };
  signalAll('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && [record.workerPid, record.runnerPid].some(isProcessAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  signalAll('SIGKILL');
  return summarize(readAgent(repoRoot, id));
}

export async function closeAgent({ repo, id, removeWorktree = false, deleteBranch = false }) {
  const repoRoot = resolveRepo(repo);
  const summary = await stopAgent({ repo: repoRoot, id });
  const record = readAgent(repoRoot, id);
  let worktree = null;
  if (removeWorktree && record.worktree) {
    worktree = removeAgentWorktree(repoRoot, record.worktree, { deleteBranch });
    updateAgent(repoRoot, id, { worktreeRemoved: true });
  }
  return { ...summary, worktree };
}

/** Cherry-pick a writer's commit into the host working tree, uncommitted. */
export function applyAgentChanges({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const record = readAgent(repoRoot, id);
  if (record.status !== 'completed') {
    throw new Error(`agent ${id} is ${record.status}; only completed agents can be applied`);
  }
  if (!record.changes?.commit) {
    return { agent_id: id, applied: false, error: 'agent left no committed changes' };
  }
  return { agent_id: id, commit: record.changes.commit, ...applyAgentCommit(repoRoot, record.changes.commit) };
}

export function listAgents({ repo, status }) {
  const repoRoot = resolveRepo(repo);
  return listAgentIds(repoRoot)
    .map((id) => summarize(reconcile(repoRoot, readAgent(repoRoot, id))))
    .filter((a) => !status || a.status === status)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Board rows for the given ids, or for every agent that is still running or
 * finished within the last `recentMinutes`.
 */
export function agentBoard({ repo, ids, recentMinutes = 30 }) {
  const repoRoot = resolveRepo(repo);
  const cutoff = Date.now() - recentMinutes * 60_000;
  const records = (ids?.length ? ids : listAgentIds(repoRoot))
    .map((id) => reconcile(repoRoot, readAgent(repoRoot, id)))
    .filter((r) => ids?.length || !TERMINAL_AGENT_STATUSES.has(r.status) || Date.parse(r.finishedAt ?? r.updatedAt) >= cutoff)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return boardRows(repoRoot, records);
}
