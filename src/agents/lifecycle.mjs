import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../constants.mjs';
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
  createSpec,
  ensureStateDirIgnored,
  isProcessAlive,
  listAgentIds,
  loadAgent,
  markCleanup,
  markStop,
  newAgentId,
  writeLaunch,
  writeRun,
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

/** The hub sets ZEDPSTACK_ACP_SESSION on the MCP it injects, whatever spawned the call. */
function agentOrigin(frontend) {
  const sessionId = process.env.ZEDPSTACK_ACP_SESSION || null;
  return { frontend: sessionId ? 'acp' : frontend, sessionId, pid: process.pid };
}

/**
 * Start one worker in the background and return its record at once.
 *
 * Fields mirror pstack's `Agent` dispatch (`prompt`, `description`,
 * `subagent_type`, `model`, `readonly`) plus zedpstack routing (`role`, `slot`,
 * `runtime`, `effort`, `isolation`, `skills`). `frontend` is the caller
 * (`mcp` or `cli`), kept out of `req` so tool arguments cannot set it.
 */
export function spawnAgent(req, { frontend = 'mcp' } = {}) {
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

  createSpec(repoRoot, {
    id,
    binding,
    role: resolved.role,
    slot: req.slot ?? 0,
    modelSource: resolved.source,
    subagentType,
    skills: req.skills ?? [],
    cliVersion,
    description: req.description ?? null,
    repoRoot,
    cwd,
    isolation,
    worktree,
    timeoutMs: req.timeout_seconds ? req.timeout_seconds * 1000 : DEFAULT_AGENT_TIMEOUT_MS,
    notes,
    createdAt: new Date().toISOString(),
    origin: agentOrigin(frontend),
    expectedModel: null,
  });

  const runnerLog = fs.openSync(path.join(dir, 'runner.log'), 'a');
  const runner = spawn(
    process.execPath,
    [dispatchScriptPath(), 'agent', 'exec', '--repo', repoRoot, '--id', id],
    { detached: true, stdio: ['ignore', runnerLog, runnerLog], cwd: repoRoot, env: process.env },
  );
  runner.unref();
  fs.closeSync(runnerLog);
  writeLaunch(repoRoot, id, { runnerPid: runner.pid });
  return summarize(loadAgent(repoRoot, id));
}

/** Body of the detached runner process (`dispatch agent exec`), the only writer of run.json. */
export async function execAgent({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const view = loadAgent(repoRoot, id);
  if (view.stop) return summarize(view);
  const { spec } = view;
  let run = { runnerPid: process.pid, workerPid: null, startedAt: new Date().toISOString(), effectiveModel: null, outcome: null };
  const save = (patch) => {
    run = writeRun(repoRoot, id, { ...run, ...patch });
  };
  const finish = (outcome) => {
    save({ outcome: { exitCode: null, timedOut: false, error: null, changes: null, changeError: null, ...outcome, finishedAt: new Date().toISOString() } });
    return summarize(loadAgent(repoRoot, id));
  };
  save({});

  const dir = agentDir(repoRoot, id);
  const sink = new EventSink(dir, { humanProgress: false });
  const extraReadDirs = [];
  try {
    extraReadDirs.push(resolvePstackInstall().skillsDir);
  } catch {
    // no pstack: workers that were told to read skills will report it
  }
  if (spec.worktree) extraReadDirs.push(repoRoot);

  let outcome;
  try {
    outcome = await runWorkerProcess({
      binding: spec.binding,
      cwd: spec.cwd,
      promptText: fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
      workerRoot: dir,
      timeoutMs: spec.timeoutMs,
      emit: (type, payload) => sink.emit(type, payload),
      eventBase: { agentId: id, role: spec.role ?? spec.subagentType },
      extraReadDirs,
      allowedTools: configData().permissions?.claudeWriteAllowedTools,
      agentId: id,
      onSpawned: ({ pid }) => save({ workerPid: pid }),
      onMeta: ({ effectiveModel }) => save({ effectiveModel }),
    });
  } catch (err) {
    sink.emit('worker.failed', { agentId: id, reason: err.message });
    return finish({ ok: false, error: err.message });
  }

  let changes = null;
  let changeError = null;
  try {
    if (spec.worktree) {
      changes = snapshotWorktree(spec.worktree, `zedpstack ${id}: ${spec.description ?? spec.role ?? 'agent'}`);
    } else if (spec.binding.permissionProfile === 'workspace-write') {
      changes = { inPlace: true, status: workingTreeChanges(spec.cwd) };
    }
  } catch (err) {
    changeError = err.message;
  }

  const { result } = outcome;
  if (changes?.commit && !result.ok) changes.partial = true;
  return finish({
    ok: result.ok,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    error: result.ok ? null : outcome.timedOut ? 'timeout' : `exit ${outcome.exitCode}${result.text === '(empty)' ? ', empty output' : ''}`,
    changes,
    changeError,
  });
}

function tailLines(file, n) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n);
}

function summarize(view) {
  const { spec } = view;
  const out = {
    agent_id: spec.id,
    status: view.status,
    description: spec.description,
    role: spec.role,
    runtime: spec.binding.runtime,
    model: spec.binding.model,
    effort: spec.binding.effort ?? null,
    readonly: spec.binding.permissionProfile === 'read-only',
    isolation: spec.isolation,
    cwd: spec.cwd,
    created_at: spec.createdAt,
    finished_at: view.finishedAt,
  };
  if (view.error) out.error = view.error;
  if (spec.notes?.length) out.notes = spec.notes;
  if (spec.worktree) out.branch = spec.worktree.branch;
  if (view.run?.effectiveModel) out.effective_model = view.run.effectiveModel;
  return out;
}

export function agentStatus({ repo, id, tail = 8 }) {
  const repoRoot = resolveRepo(repo);
  return {
    ...summarize(loadAgent(repoRoot, id)),
    progress: tailLines(path.join(agentDir(repoRoot, id), 'progress.log'), tail),
  };
}

export function agentResult({ repo, id, maxChars = MAX_INLINE_RESULT_CHARS }) {
  const repoRoot = resolveRepo(repo);
  const view = loadAgent(repoRoot, id);
  const dir = agentDir(repoRoot, id);
  const resultPath = path.join(dir, 'result.json');
  const out = { ...summarize(view) };
  if (!TERMINAL_AGENT_STATUSES.has(view.status)) {
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
  const outcome = view.run?.outcome;
  if (outcome?.changes) out.changes = outcome.changes;
  if (outcome?.changeError) out.change_error = outcome.changeError;
  if (view.status === 'failed') {
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
    : listAgentIds(repoRoot).filter((id) => !TERMINAL_AGENT_STATUSES.has(loadAgent(repoRoot, id).status));
  const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
  for (;;) {
    const views = targets.map((id) => loadAgent(repoRoot, id));
    const done = views.filter((v) => TERMINAL_AGENT_STATUSES.has(v.status));
    onTick?.({ done: done.length, total: views.length, rows: boardRows(repoRoot, views) });
    const finished = mode === 'any' ? done.length > 0 : done.length === views.length;
    if (finished || Date.now() >= deadline) {
      return {
        timed_out: !finished,
        done: done.map((v) => agentResult({ repo: repoRoot, id: v.spec.id })),
        pending: views
          .filter((v) => !TERMINAL_AGENT_STATUSES.has(v.status))
          .map((v) => agentStatus({ repo: repoRoot, id: v.spec.id, tail: 3 })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function stopAgent({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const before = loadAgent(repoRoot, id);
  if (TERMINAL_AGENT_STATUSES.has(before.status)) return summarize(before);
  const { created } = markStop(repoRoot, id, `pid ${process.pid}`);
  const view = loadAgent(repoRoot, id);
  if (!created) return summarize(view);
  const runnerPid = view.run?.runnerPid ?? view.launch?.runnerPid;
  const pids = [view.run?.workerPid, runnerPid];
  const signalAll = (signal) => {
    for (const pid of pids) {
      if (!isProcessAlive(pid)) continue;
      try {
        process.kill(pid === runnerPid ? -pid : pid, signal);
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
  while (Date.now() < deadline && pids.some(isProcessAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  signalAll('SIGKILL');
  return summarize(loadAgent(repoRoot, id));
}

/** Ids of the unfinished agents an ACP session started at or after `sinceMs`. */
export function liveSessionAgentIds({ repo, sessionId, sinceMs = 0 }) {
  const repoRoot = resolveRepo(repo);
  return listAgentIds(repoRoot).filter((id) => {
    let view;
    try {
      view = loadAgent(repoRoot, id);
    } catch {
      return false;
    }
    return view.spec.origin?.sessionId === sessionId
      && Date.parse(view.spec.createdAt) >= sinceMs
      && !TERMINAL_AGENT_STATUSES.has(view.status);
  });
}

/**
 * Stop what `liveSessionAgentIds` selects. Each stop is marked before this
 * returns its promise, which settles once the processes are gone.
 */
export function stopSessionAgents({ repo, sessionId, sinceMs }) {
  const ids = liveSessionAgentIds({ repo, sessionId, sinceMs });
  const stops = ids.map((id) => stopAgent({ repo, id }).catch(() => null));
  return Promise.all(stops).then(() => ids);
}

export async function closeAgent({ repo, id, removeWorktree = false, deleteBranch = false }) {
  const repoRoot = resolveRepo(repo);
  const summary = await stopAgent({ repo: repoRoot, id });
  const { spec } = loadAgent(repoRoot, id);
  let worktree = null;
  if (removeWorktree && spec.worktree) {
    worktree = removeAgentWorktree(repoRoot, spec.worktree, { deleteBranch });
    if (worktree.removed) markCleanup(repoRoot, id, { branchDeleted: worktree.branchDeleted });
  }
  return { ...summary, worktree };
}

/** Cherry-pick a writer's commit into the host working tree, uncommitted. */
export function applyAgentChanges({ repo, id }) {
  const repoRoot = resolveRepo(repo);
  const view = loadAgent(repoRoot, id);
  if (view.status !== 'completed') {
    throw new Error(`agent ${id} is ${view.status}; only completed agents can be applied`);
  }
  const commit = view.run.outcome.changes?.commit;
  if (!commit) {
    return { agent_id: id, applied: false, error: 'agent left no committed changes' };
  }
  return { agent_id: id, commit, ...applyAgentCommit(repoRoot, commit) };
}

export function listAgents({ repo, status }) {
  const repoRoot = resolveRepo(repo);
  return listAgentIds(repoRoot)
    .map((id) => summarize(loadAgent(repoRoot, id)))
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
  const lastActive = (v) => Date.parse(v.finishedAt ?? v.run?.startedAt ?? v.spec.createdAt);
  const views = (ids?.length ? ids : listAgentIds(repoRoot))
    .map((id) => loadAgent(repoRoot, id))
    .filter((v) => ids?.length || !TERMINAL_AGENT_STATUSES.has(v.status) || lastActive(v) >= cutoff)
    .sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt));
  return boardRows(repoRoot, views);
}
