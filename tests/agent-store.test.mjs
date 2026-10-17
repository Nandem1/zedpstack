import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentBoard, agentResult, agentStatus, listAgents, spawnAgent, waitAgents } from '../src/agents/lifecycle.mjs';
import {
  START_GRACE_MS,
  agentDir,
  createSpec,
  deriveStatus,
  loadAgent,
  markCleanup,
  markStop,
  writeLaunch,
  writeRun,
} from '../src/agents/store.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';
import { childEnv } from './helpers/env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE_URL = pathToFileURL(path.join(ROOT, 'src', 'agents', 'store.mjs')).href;

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const outcome = (ok, extra = {}) => ({
  ok, exitCode: ok ? 0 : 1, timedOut: false, error: ok ? null : 'exit 1', changes: null, changeError: null,
  finishedAt: new Date().toISOString(), ...extra,
});
const runState = (extra = {}) => ({
  runnerPid: process.pid, workerPid: null, startedAt: new Date().toISOString(), effectiveModel: null, outcome: null, ...extra,
});

function seedSpec(repo, id, extra = {}) {
  return createSpec(repo, {
    id,
    binding: { runtime: 'claude', model: 'haiku', permissionProfile: 'read-only' },
    role: 'how explorer',
    description: id,
    repoRoot: repo,
    cwd: repo,
    isolation: 'none',
    worktree: null,
    timeoutMs: 60_000,
    notes: [],
    createdAt: new Date().toISOString(),
    origin: { frontend: 'mcp', sessionId: null, pid: process.pid },
    expectedModel: null,
    ...extra,
  });
}

function mtimes(repo) {
  const out = {};
  const walk = (dir) => {
    out[dir] = fs.statSync(dir).mtimeMs;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[p] = fs.statSync(p).mtimeMs;
    }
  };
  walk(path.join(repo, '.zedpstack', 'agents'));
  return out;
}

describe('deriveStatus', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const spec = { createdAt: '2026-10-17T11:59:55Z' };
  const old = { createdAt: '2026-10-17T11:00:00Z' };
  const stop = { requestedAt: '2026-10-17T11:59:58Z', by: 't' };

  it('stop wins over everything, including a later completed outcome', () => {
    assert.equal(deriveStatus(spec, { outcome: outcome(true) }, null, stop, false, now), 'stopped');
    assert.equal(deriveStatus(spec, { outcome: outcome(false) }, null, stop, true, now), 'stopped');
    assert.equal(deriveStatus(old, null, null, stop, false, now), 'stopped');
  });

  it('an outcome decides completed or failed whatever the runner pid says', () => {
    assert.equal(deriveStatus(spec, { outcome: outcome(true) }, null, null, false, now), 'completed');
    assert.equal(deriveStatus(spec, { outcome: outcome(false) }, null, null, true, now), 'failed');
  });

  it('a live runner with run state is running', () => {
    assert.equal(deriveStatus(old, runState(), null, null, true, now), 'running');
  });

  it('no run yet is starting within the grace or while the runner lives', () => {
    assert.equal(deriveStatus(spec, null, { runnerPid: 1 }, null, false, now), 'starting');
    assert.equal(deriveStatus(old, null, { runnerPid: 1 }, null, true, now), 'starting');
    assert.equal(deriveStatus({ createdAt: new Date(now - START_GRACE_MS + 1).toISOString() }, null, null, null, false, now), 'starting');
  });

  it('a dead runner without an outcome is failed', () => {
    assert.equal(deriveStatus(old, null, { runnerPid: 1 }, null, false, now), 'failed');
    assert.equal(deriveStatus(spec, runState(), null, null, false, now), 'failed');
  });
});

describe('agent store files', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
  });

  it('createSpec refuses to overwrite an existing spec', () => {
    seedSpec(sb.repo, 'spec-once', { description: 'first' });
    assert.throws(() => seedSpec(sb.repo, 'spec-once', { description: 'second' }), /already exists/);
    assert.equal(loadAgent(sb.repo, 'spec-once').spec.description, 'first');
    assert.equal(loadAgent(sb.repo, 'spec-once').spec.version, 2);
  });

  it('markStop is idempotent: the first stop wins', () => {
    seedSpec(sb.repo, 'stop-twice');
    const first = markStop(sb.repo, 'stop-twice', 'a');
    const second = markStop(sb.repo, 'stop-twice', 'b');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.stop, first.stop);
    assert.equal(loadAgent(sb.repo, 'stop-twice').stop.by, 'a');
  });

  it('loadAgent merges every actor file into one view', () => {
    seedSpec(sb.repo, 'merged');
    writeLaunch(sb.repo, 'merged', { runnerPid: process.pid });
    assert.equal(loadAgent(sb.repo, 'merged').status, 'starting');
    writeRun(sb.repo, 'merged', runState({ workerPid: 42, effectiveModel: 'claude-haiku-x' }));
    assert.equal(loadAgent(sb.repo, 'merged').status, 'running');
    writeRun(sb.repo, 'merged', runState({ outcome: outcome(true, { changes: { commit: 'abc' } }) }));
    markCleanup(sb.repo, 'merged', { branchDeleted: true });
    const view = loadAgent(sb.repo, 'merged');
    assert.equal(view.status, 'completed');
    assert.equal(view.error, null);
    assert.equal(view.finishedAt, view.run.outcome.finishedAt);
    assert.deepEqual(view.launch, { runnerPid: process.pid });
    assert.equal(view.run.outcome.changes.commit, 'abc');
    assert.equal(view.cleanup.branchDeleted, true);
    assert.equal(view.stop, null);
    assert.throws(() => writeLaunch(sb.repo, 'merged', { runnerPid: 1 }), /already launched/);
  });

  for (const status of ['failed', 'stopped']) {
    it(`a polluted v2 spec with stale ${status} status derives completed from run.json`, () => {
      const id = `polluted-completed-${status}`;
      const spec = seedSpec(sb.repo, id);
      const specFile = path.join(agentDir(sb.repo, id), 'agent.json');
      const polluted = JSON.stringify({
        ...spec, status, error: 'stale legacy error',
        finishedAt: '2026-01-01T00:01:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z',
      });
      fs.writeFileSync(specFile, polluted);
      const run = runState({ outcome: outcome(true, { finishedAt: '2026-10-17T12:00:00.000Z' }) });
      writeRun(sb.repo, id, run);

      const view = loadAgent(sb.repo, id);
      assert.equal(view.status, 'completed');
      assert.equal(view.error, null);
      assert.equal(view.finishedAt, run.outcome.finishedAt);
      assert.equal(view.spec.version, 2);
      assert.deepEqual(view.spec.binding, spec.binding);
      assert.equal(view.stop, null);
      assert.equal(fs.readFileSync(specFile, 'utf8'), polluted);
    });
  }

  it('a polluted v2 spec derives stopped from stop.json', () => {
    const id = 'polluted-stopped';
    const spec = seedSpec(sb.repo, id);
    const specFile = path.join(agentDir(sb.repo, id), 'agent.json');
    const polluted = JSON.stringify({
      ...spec, status: 'completed', error: 'stale legacy error',
      finishedAt: '2026-01-01T00:01:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z',
    });
    fs.writeFileSync(specFile, polluted);
    writeRun(sb.repo, id, runState({ outcome: outcome(true) }));
    const { stop } = markStop(sb.repo, id, 'test');

    const view = loadAgent(sb.repo, id);
    assert.equal(view.status, 'stopped');
    assert.equal(view.error, 'stopped by orchestrator');
    assert.equal(view.finishedAt, stop.requestedAt);
    assert.equal(view.spec.version, 2);
    assert.deepEqual(view.spec.binding, spec.binding);
    assert.deepEqual(view.stop, stop);
    assert.equal(fs.readFileSync(specFile, 'utf8'), polluted);
  });

  it('a polluted v2 spec without run.json uses launch.json instead of legacy outcomes', () => {
    const id = 'polluted-starting';
    const spec = seedSpec(sb.repo, id, { createdAt: '2026-01-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(agentDir(sb.repo, id), 'agent.json'), JSON.stringify({
      ...spec, status: 'failed', error: 'stale legacy error',
      finishedAt: '2026-01-01T00:01:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z',
    }));
    writeLaunch(sb.repo, id, { runnerPid: process.pid });

    const view = loadAgent(sb.repo, id);
    assert.equal(view.status, 'starting');
    assert.equal(view.error, null);
    assert.equal(view.finishedAt, null);
    assert.equal(view.run, null);
  });

  it('reads a v1 record through the adapter and never rewrites it', () => {
    const write = (id, record) => {
      fs.mkdirSync(agentDir(sb.repo, id), { recursive: true });
      const file = path.join(agentDir(sb.repo, id), 'agent.json');
      fs.writeFileSync(file, JSON.stringify({
        id, description: 'old', role: 'how explorer', runtime: 'codex', model: 'gpt-6.1-sol',
        permissionProfile: 'workspace-write', effort: 'high', repoRoot: sb.repo, cwd: sb.repo, isolation: 'worktree',
        worktree: { branch: `zedpstack/${id}`, path: '/nowhere' }, createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z', ...record,
      }));
      return file;
    };
    const done = write('v1-done', {
      status: 'completed', finishedAt: '2026-01-01T00:04:00.000Z', exitCode: 0, effectiveModel: 'gpt-x',
      changes: { commit: 'c0ffee', files: ['A\tx'] }, runnerPid: deadPid(), workerPid: null,
    });
    const before = fs.readFileSync(done, 'utf8');
    const view = loadAgent(sb.repo, 'v1-done');
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.spec.binding, { runtime: 'codex', model: 'gpt-6.1-sol', permissionProfile: 'workspace-write', effort: 'high' });
    assert.equal(view.run.outcome.changes.commit, 'c0ffee');
    assert.equal(view.run.effectiveModel, 'gpt-x');
    assert.equal(view.finishedAt, '2026-01-01T00:04:00.000Z');

    write('v1-stopped', { status: 'stopped', finishedAt: '2026-01-01T00:03:00.000Z', error: 'stopped by orchestrator', worktreeRemoved: true });
    const stopped = loadAgent(sb.repo, 'v1-stopped');
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.finishedAt, '2026-01-01T00:03:00.000Z');
    assert.ok(stopped.cleanup);

    write('v1-orphan', { status: 'running', runnerPid: deadPid(), startedAt: '2026-01-01T00:00:01.000Z' });
    assert.equal(loadAgent(sb.repo, 'v1-orphan').status, 'failed');
    assert.match(agentStatus({ repo: sb.repo, id: 'v1-orphan' }).error, /runner process exited/);

    assert.equal(fs.readFileSync(done, 'utf8'), before, 'v1 agent.json untouched');
    assert.ok(!fs.existsSync(path.join(agentDir(sb.repo, 'v1-orphan'), 'run.json')), 'reader wrote nothing');

    markStop(sb.repo, 'v1-orphan', 't');
    assert.equal(loadAgent(sb.repo, 'v1-orphan').status, 'stopped', 'stop.json applies to v1 records too');
  });

  it('status, result, list and board reads leave every file untouched', () => {
    seedSpec(sb.repo, 'orphan', { createdAt: new Date(Date.now() - START_GRACE_MS - 1000).toISOString() });
    writeLaunch(sb.repo, 'orphan', { runnerPid: deadPid() });
    seedSpec(sb.repo, 'orphan-running');
    writeRun(sb.repo, 'orphan-running', runState({ runnerPid: deadPid() }));
    const before = mtimes(sb.repo);
    assert.equal(agentStatus({ repo: sb.repo, id: 'orphan' }).status, 'failed');
    assert.equal(agentStatus({ repo: sb.repo, id: 'orphan-running' }).status, 'failed');
    agentResult({ repo: sb.repo, id: 'orphan' });
    assert.ok(listAgents({ repo: sb.repo }).length >= 2);
    assert.ok(agentBoard({ repo: sb.repo }).some((r) => r.id === 'orphan' && r.status === 'failed'));
    agentBoard({ repo: sb.repo, ids: ['orphan', 'orphan-running'] });
    assert.deepEqual(mtimes(sb.repo), before);
  });

  it('a stop racing the runner always ends stopped (200 in-process interleavings)', async () => {
    const step = (fn) => new Promise((resolve) => setImmediate(() => resolve(fn())));
    for (let i = 0; i < 200; i += 1) {
      const id = `race-${i}`;
      seedSpec(sb.repo, id);
      const runner = async () => {
        await step(() => writeRun(sb.repo, id, runState()));
        await step(() => writeRun(sb.repo, id, runState({ workerPid: 7 })));
        await step(() => writeRun(sb.repo, id, runState({ workerPid: 7, effectiveModel: 'm' })));
        await step(() => writeRun(sb.repo, id, runState({ workerPid: 7, outcome: outcome(i % 2 === 0) })));
      };
      const stopper = async () => {
        for (let k = 0; k < i % 5; k += 1) await step(() => {});
        markStop(sb.repo, id, 'race');
      };
      await Promise.all([runner(), stopper()]);
      const view = loadAgent(sb.repo, id);
      assert.ok(view.run.outcome, `${id} runner finished`);
      assert.equal(view.status, 'stopped', `${id} stays stopped`);
    }
  });

  it('a stop racing a runner in another process always ends stopped', async () => {
    const n = 200;
    const ids = Array.from({ length: n }, (_, i) => `xrace-${i}`);
    for (const id of ids) seedSpec(sb.repo, id);
    const script = `
      const { writeRun } = await import(${JSON.stringify(STORE_URL)});
      const [repo, n] = process.argv.slice(1);
      for (let i = 0; i < Number(n); i += 1) {
        const id = 'xrace-' + i;
        const base = { runnerPid: process.pid, workerPid: 1, startedAt: new Date().toISOString(), effectiveModel: null, outcome: null };
        writeRun(repo, id, base);
        writeRun(repo, id, { ...base, outcome: { ok: true, exitCode: 0, timedOut: false, error: null, changes: null, changeError: null, finishedAt: new Date().toISOString() } });
      }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, sb.repo, String(n)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    for (const id of ids) {
      markStop(sb.repo, id, 'parent');
      assert.equal(loadAgent(sb.repo, id).status, 'stopped');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await exited, 0, stderr);
    for (const id of ids) {
      const view = loadAgent(sb.repo, id);
      assert.ok(view.run?.outcome?.ok, `${id} child finished`);
      assert.equal(view.status, 'stopped', `${id} stays stopped`);
    }
  });
});

describe('agent origin', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
  });

  it('records which frontend spawned the agent', async () => {
    const prev = process.env.ZEDPSTACK_ACP_SESSION;
    const req = { repo: sb.repo, model: 'haiku', readonly: true, prompt: 'origin check' };
    try {
      delete process.env.ZEDPSTACK_ACP_SESSION;
      const mcp = spawnAgent(req);
      process.env.ZEDPSTACK_ACP_SESSION = 'sess-42';
      const acp = spawnAgent(req, { frontend: 'cli' });
      delete process.env.ZEDPSTACK_ACP_SESSION;

      const cli = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'dispatch.mjs'), 'agent', 'spawn', '--repo', sb.repo, '--model', 'haiku', '--readonly', '--prompt', 'origin check'],
        { env: childEnv(), encoding: 'utf8' },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const cliId = JSON.parse(cli.stdout).agent_id;

      assert.deepEqual(loadAgent(sb.repo, mcp.agent_id).spec.origin, { frontend: 'mcp', sessionId: null, pid: process.pid });
      assert.deepEqual(loadAgent(sb.repo, acp.agent_id).spec.origin, { frontend: 'acp', sessionId: 'sess-42', pid: process.pid });
      const cliOrigin = loadAgent(sb.repo, cliId).spec.origin;
      assert.equal(cliOrigin.frontend, 'cli');
      assert.equal(cliOrigin.sessionId, null);
      assert.equal(loadAgent(sb.repo, cliId).spec.expectedModel, null);

      const waited = await waitAgents({ repo: sb.repo, ids: [mcp.agent_id, acp.agent_id, cliId], timeoutSeconds: 20, pollMs: 100 });
      assert.equal(waited.timed_out, false);
      assert.deepEqual(waited.done.map((d) => d.status), ['completed', 'completed', 'completed']);
    } finally {
      if (prev === undefined) delete process.env.ZEDPSTACK_ACP_SESSION;
      else process.env.ZEDPSTACK_ACP_SESSION = prev;
    }
  });
});
