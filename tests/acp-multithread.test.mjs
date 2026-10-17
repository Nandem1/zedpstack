import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopAgent } from '../src/agents/lifecycle.mjs';
import { createSpec, isProcessAlive, listAgentIds, loadAgent, TERMINAL_AGENT_STATUSES, writeRun } from '../src/agents/store.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';
import { createHub } from '../src/acp/hub.mjs';
import { startEngine } from '../src/acp/engine.mjs';

const RESOURCE_FIXTURE = fileURLToPath(new URL('./fixtures/acp-resources.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userText = (text) => [{ type: 'text', text }];
const chunks = (ctx, sessionId) => ctx.updates
  .filter((item) => item.sessionId === sessionId && item.update.sessionUpdate === 'agent_message_chunk')
  .map((item) => item.update.content.text);
const spawnedId = (ctx, sessionId) => chunks(ctx, sessionId).find((text) => text.startsWith('spawned:'))?.slice(8);
const readTrace = (file) => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  : [];

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function seedFinishedAgent(repo, id, sessionId) {
  const now = new Date().toISOString();
  createSpec(repo, {
    id,
    binding: { runtime: 'claude', model: 'haiku', permissionProfile: 'read-only' },
    description: id,
    role: 'how explorer',
    slot: 0,
    repoRoot: repo,
    cwd: repo,
    isolation: 'none',
    worktree: null,
    createdAt: now,
    origin: { frontend: 'acp', sessionId, pid: process.pid },
  });
  writeRun(repo, id, {
    runnerPid: null,
    workerPid: null,
    startedAt: now,
    effectiveModel: null,
    outcome: { ok: true, exitCode: 0, timedOut: false, error: null, changes: null, changeError: null, finishedAt: now },
  });
}

function setup(t, twoRepos, extraEnv = {}, options = {}) {
  const first = makeSandbox();
  const second = twoRepos ? makeSandbox() : first;
  const repos = [first.repo, first.repo, second.repo, second.repo];
  const home = shortHome('zp-multi-');
  const env = childEnv(engineEnv({
    ZEDPSTACK_HOME: home,
    FAKE_ACP_TRACE: path.join(home, 'calls.jsonl'),
    ...extraEnv,
  }));
  const ctx = connectHub(t, env, { log: () => {}, ...options });
  t.after(async () => {
    for (const repo of new Set(repos)) {
      const live = listAgentIds(repo).filter((id) => !TERMINAL_AGENT_STATUSES.has(loadAgent(repo, id).status));
      await Promise.all(live.map((id) => stopAgent({ repo, id })));
    }
  });
  return { ctx, env, repos };
}

async function openFour(ctx, repos) {
  const sessions = await Promise.all(repos.map((cwd) => ctx.rpc('session/new', { cwd, mcpServers: [] })));
  assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 4);
  assert.equal(ctx.engines.length, 4);
  assert.equal(new Set(ctx.engines.map((engine) => engine.pid)).size, 4);
  return sessions.map((session) => session.sessionId);
}

function engineForSession(ctx, env, sessionId) {
  const call = readTrace(env.FAKE_ACP_TRACE).find((entry) => entry.method === 'session/new'
    && entry.params.mcpServers.some((server) => server.env?.some((item) => item.name === 'ZEDPSTACK_ACP_SESSION' && item.value === sessionId)));
  return ctx.engines.find((engine) => engine.pid === call?.pid);
}

function pendingPrompt(ctx, sessionId, text) {
  const state = { settled: false, result: null };
  state.promise = ctx.rpc('session/prompt', { sessionId, prompt: userText(text) }).then((result) => {
    state.settled = true;
    state.result = result;
    return result;
  });
  return state;
}

for (const twoRepos of [false, true]) {
  describe(`four ACP threads on ${twoRepos ? 'two repos' : 'the same repo'}`, { timeout: 45_000 }, () => {
    it('isolates cards, permission answers and runtime switches while other turns wait', async (t) => {
      const answers = new Map();
      const { ctx, env, repos } = setup(t, twoRepos, {}, {
        clientRequest: (method, params) => {
          if (method !== 'session/request_permission') return undefined;
          return new Promise((resolve) => answers.set(params.sessionId, resolve));
        },
      });
      const ids = await openFour(ctx, repos);
      ids.forEach((sessionId, i) => seedFinishedAgent(repos[i], `owned-${i}`, sessionId));
      const turns = ids.map((sessionId) => pendingPrompt(ctx, sessionId, 'ASK'));
      await waitFor(() => answers.size === 4 && ids.every((sessionId) => ctx.updates.some((item) => item.sessionId === sessionId
        && item.update.toolCallId?.startsWith('zp-owned-') && item.update.status === 'completed')), 'four permission asks and own cards');
      for (const [i, sessionId] of ids.entries()) {
        const cards = ctx.updates.filter((item) => item.sessionId === sessionId && item.update.toolCallId?.startsWith('zp-owned-'));
        assert.deepEqual([...new Set(cards.map((item) => item.update.toolCallId))], [`zp-owned-${i}`]);
      }
      assert.deepEqual(new Set(ctx.clientRequests.map((request) => request.params.sessionId)), new Set(ids));
      const original = ids.map((sessionId) => engineForSession(ctx, env, sessionId));
      assert.ok(original.every((engine) => engine && isProcessAlive(engine.pid)));

      answers.get(ids[0])({ outcome: { outcome: 'selected', optionId: 'ok' } });
      assert.equal((await turns[0].promise).stopReason, 'end_turn');
      for (const runtime of ['codex', 'claude']) {
        assert.equal((await ctx.rpc('session/prompt', { sessionId: ids[0], prompt: userText(`/${runtime}`) })).stopReason, 'end_turn');
        assert.equal(ctx.engines.at(-1).runtime, runtime);
        assert.equal(ctx.updates.findLast((item) => item.sessionId === ids[0]
          && item.update.sessionUpdate === 'config_option_update').update.configOptions
          .find((option) => option.id === 'zp.runtime').currentValue, runtime);
        assert.deepEqual(turns.slice(1).map((turn) => turn.settled), [false, false, false]);
        assert.deepEqual(original.slice(1).map((engine) => isProcessAlive(engine.pid)), [true, true, true]);
      }
      assert.equal(isProcessAlive(original[0].pid), false);
      assert.equal(ctx.engines.length, 6, 'only the selected thread replaces its engine twice');

      for (let i = 3; i >= 1; i -= 1) {
        answers.get(ids[i])({ outcome: i === 2 ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: 'ok' } });
        assert.equal((await turns[i].promise).stopReason, 'end_turn');
        assert.ok(chunks(ctx, ids[i]).includes(`perm:${i === 2 ? 'cancelled' : 'selected'}`));
        for (let waiting = 1; waiting < i; waiting += 1) assert.equal(turns[waiting].settled, false);
      }
      for (const sessionId of ids) {
        assert.equal((await ctx.rpc('session/prompt', { sessionId, prompt: userText('still usable') })).stopReason, 'end_turn');
      }
      for (const call of readTrace(env.FAKE_ACP_TRACE).filter((entry) => entry.method === 'session/prompt')) {
        const owner = original.findIndex((engine) => engine.pid === call.pid);
        if (owner > 0) assert.doesNotMatch(call.params.prompt.at(-1).text, /^\/(?:claude|codex)$/);
      }
    });

    it('cancel, crash and closing one thread preserve other turns and live workers', async (t) => {
      const { ctx, env, repos } = setup(t, twoRepos, { FAKE_ACP_MCP: '1' });
      const ids = await openFour(ctx, repos);
      const engines = ids.map((sessionId) => engineForSession(ctx, env, sessionId));
      const turns = ids.map((sessionId) => pendingPrompt(ctx, sessionId, 'SPAWN FAKE_SLEEP SLEEP'));
      await waitFor(() => ids.every((sessionId, i) => {
        const id = spawnedId(ctx, sessionId);
        return id && loadAgent(repos[i], id).status === 'running';
      }), 'four running workers');
      const agents = ids.map((sessionId) => spawnedId(ctx, sessionId));
      const pids = agents.map((id, i) => {
        const view = loadAgent(repos[i], id);
        assert.equal(view.spec.origin.sessionId, ids[i]);
        return [view.run.workerPid, view.run.runnerPid].filter(Boolean);
      });
      const assertUntouched = (indexes) => {
        for (const i of indexes) {
          assert.equal(turns[i].settled, false, `thread ${i} still has its open turn`);
          assert.equal(isProcessAlive(engines[i].pid), true, `engine ${i} stays alive`);
          assert.equal(loadAgent(repos[i], agents[i]).status, 'running', `worker ${i} keeps running`);
          assert.ok(pids[i].every(isProcessAlive), `worker ${i} processes stay alive`);
          assert.ok(!ctx.updates.some((item) => item.sessionId === ids[i]
            && item.update.toolCallId === `zp-${agents[i]}` && item.update.status === 'failed'));
        }
      };

      await ctx.hub.notify({ method: 'session/cancel', params: { sessionId: ids[0] } });
      assert.equal((await turns[0].promise).stopReason, 'cancelled');
      assert.equal(loadAgent(repos[0], agents[0]).status, 'stopped');
      assert.ok(pids[0].every((pid) => !isProcessAlive(pid)));
      assertUntouched([1, 2, 3]);
      const crashing = pendingPrompt(ctx, ids[0], 'MCPHOLD SLEEP');
      await waitFor(() => chunks(ctx, ids[0]).some((text) => text.startsWith('mcp:')), 'MCP child held before crash');
      const mcpPid = Number(chunks(ctx, ids[0]).find((text) => text.startsWith('mcp:')).slice(4));
      assert.equal(isProcessAlive(mcpPid), true);
      process.kill(engines[0].pid, 'SIGKILL');
      assert.equal((await crashing.promise).stopReason, 'refusal');
      await waitFor(() => !isProcessAlive(mcpPid), 'crashed engine MCP cleaned while hub stays up');
      assertUntouched([1, 2, 3]);
      assert.equal((await ctx.rpc('session/prompt', { sessionId: ids[0], prompt: userText('restart') })).stopReason, 'end_turn');
      assertUntouched([1, 2, 3]);

      assert.deepEqual(await ctx.rpc('session/close', { sessionId: ids[1] }), {});
      assert.equal((await turns[1].promise).stopReason, 'cancelled');
      assert.equal(isProcessAlive(engines[1].pid), false);
      assert.equal(loadAgent(repos[1], agents[1]).status, 'running', 'detached workers survive closing their thread');
      assertUntouched([2, 3]);
      const cancels = readTrace(env.FAKE_ACP_TRACE).filter((entry) => entry.method === 'session/cancel');
      assert.deepEqual(cancels.map((entry) => entry.pid), [engines[0].pid]);
      for (const i of [2, 3]) {
        await ctx.hub.notify({ method: 'session/cancel', params: { sessionId: ids[i] } });
        assert.equal((await turns[i].promise).stopReason, 'cancelled');
      }
    });
  });
}

describe('ACP engine capacity', { timeout: 30_000 }, () => {
  it('closing a recovery turn queued behind another startup returns cancelled without a late message', async (t) => {
    const home = shortHome('zp-close-recover-');
    const env = childEnv(engineEnv({ ZEDPSTACK_HOME: home }));
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let starts = 0;
    const updates = [];
    const hub = createHub({ env, log: () => {}, zed: { request: async () => ({}), notify: (update) => updates.push(update) }, spawnEngine: async (opts) => {
      if (++starts === 2) { enter(); await gate; }
      return startEngine(opts);
    } });
    t.after(async () => { release(); await hub.shutdown(); });
    const a = await hub.handle['session/new']({ cwd: home });
    assert.equal((await hub.handle['session/prompt']({ sessionId: a.sessionId, prompt: userText('CRASH') })).stopReason, 'refusal');
    const openingB = hub.handle['session/new']({ cwd: home });
    await entered;
    const recovery = hub.handle['session/prompt']({ sessionId: a.sessionId, prompt: userText('recover') });
    await new Promise(setImmediate);
    const closing = hub.handle['session/close']({ sessionId: a.sessionId });
    const count = updates.filter((update) => update.sessionId === a.sessionId).length;
    release();
    await Promise.all([openingB, closing]);
    assert.equal((await recovery).stopReason, 'cancelled');
    assert.equal(updates.filter((update) => update.sessionId === a.sessionId).length, count, 'closed session emits no unavailable message');
    assert.equal(starts, 2, 'the queued recovery does not start another engine');
  });

  it('a prompt waits for its runtime switch while another session holds engine admission', async (t) => {
    const home = shortHome('zp-switch-turn-');
    const trace = path.join(home, 'calls.jsonl');
    const env = childEnv(engineEnv({ ZEDPSTACK_HOME: home, FAKE_ACP_TRACE: trace }));
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const engines = [];
    let starts = 0;
    const hub = createHub({ env, log: () => {}, zed: { request: async () => ({}) }, spawnEngine: async (opts) => {
      if (++starts === 2) { enter(); await gate; }
      const engine = await startEngine(opts);
      engines.push(engine);
      return engine;
    } });
    t.after(async () => { release(); await hub.shutdown(); });
    const a = await hub.handle['session/new']({ cwd: home });
    const openingB = hub.handle['session/new']({ cwd: home });
    await entered;
    const switching = hub.handle['session/set_config_option']({ sessionId: a.sessionId, configId: 'zp.runtime', value: 'codex' });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const pending = hub.handle['session/prompt']({ sessionId: a.sessionId, prompt: userText('after switch') });
    await sleep(25);
    assert.equal(readTrace(trace).some((call) => call.method === 'session/prompt'), false, 'no prompt reaches the engine being replaced');
    release();
    await Promise.all([switching, openingB]);
    assert.equal((await pending).stopReason, 'end_turn');
    const call = readTrace(trace).find((entry) => entry.method === 'session/prompt');
    assert.equal(call.pid, engines[2].pid);
    assert.equal(engines[2].runtime, 'codex');
    assert.equal(isProcessAlive(engines[0].pid), false);
  });

  it('close and shutdown wait for an engine already starting, and shutdown refuses new sessions', async (t) => {
    const home = shortHome('zp-start-close-');
    const env = childEnv(engineEnv({ ZEDPSTACK_HOME: home }));
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let engine;
    const hub = createHub({ env, log: () => {}, zed: { request: async () => ({}) }, spawnEngine: async (opts) => {
      enter(opts.mcpServers.at(-1).env.find((value) => value.name === 'ZEDPSTACK_ACP_SESSION').value);
      await gate;
      engine = await startEngine(opts);
      return engine;
    } });
    t.after(async () => { release(); await hub.shutdown(); });
    const opening = hub.handle['session/new']({ cwd: home });
    const sessionId = await entered;
    let closed = false;
    const closing = hub.handle['session/close']({ sessionId }).then(() => { closed = true; });
    let shut = false;
    const shutdown = hub.shutdown().then(() => { shut = true; });
    await new Promise(setImmediate);
    assert.equal(closed, false);
    assert.equal(shut, false);
    await assert.rejects(hub.handle['session/new']({ cwd: home }), /hub shutting down/);
    release();
    await Promise.all([opening, closing, shutdown]);
    assert.equal(isProcessAlive(engine.pid), false);
    assert.equal(fs.existsSync(hub.bridgePath), false);
  });

  it('evicts the least recently used idle engine while an older active turn keeps running', async (t) => {
    const { ctx, env, repos } = setup(t, false, { ZEDPSTACK_ACP_MAX_ENGINES: '4' });
    const ids = [];
    for (const cwd of repos) ids.push((await ctx.rpc('session/new', { cwd, mcpServers: [] })).sessionId);
    const engines = ids.map((sessionId) => engineForSession(ctx, env, sessionId));
    const active = pendingPrompt(ctx, ids[0], 'SLEEP');
    await waitFor(() => readTrace(env.FAKE_ACP_TRACE).some((entry) => entry.pid === engines[0].pid && entry.method === 'session/prompt'), 'active turn');
    for (const sessionId of ids.slice(1)) {
      await sleep(5);
      await ctx.rpc('session/prompt', { sessionId, prompt: userText('touch idle engine') });
    }
    await ctx.rpc('session/new', { cwd: repos[0], mcpServers: [] });
    await waitFor(() => !isProcessAlive(engines[1].pid), 'least recently used idle engine evicted');
    assert.deepEqual([0, 2, 3].map((i) => isProcessAlive(engines[i].pid)), [true, true, true]);
    assert.equal(active.settled, false);
    assert.equal(ctx.engines.filter((engine) => isProcessAlive(engine.pid)).length, 4);
    await ctx.hub.notify({ method: 'session/cancel', params: { sessionId: ids[0] } });
    assert.equal((await active.promise).stopReason, 'cancelled');
  });

  it('concurrent session startups never exceed the process cap', async (t) => {
    const { ctx, env, repos } = setup(t, false, { ZEDPSTACK_ACP_MAX_ENGINES: '2' });
    let peak = 0;
    const sample = () => {
      const pids = new Set(readTrace(env.FAKE_ACP_TRACE).filter((entry) => entry.method === 'initialize').map((entry) => entry.pid));
      peak = Math.max(peak, [...pids].filter(isProcessAlive).length);
    };
    const timer = setInterval(sample, 2);
    t.after(() => clearInterval(timer));
    await Promise.all(repos.map((cwd) => ctx.rpc('session/new', { cwd, mcpServers: [] })));
    sample();
    clearInterval(timer);
    assert.ok(peak <= 2, `observed ${peak} live engine processes with a cap of 2`);
    assert.ok(ctx.engines.filter((engine) => isProcessAlive(engine.pid)).length <= 2);
  });

  it('rejects extra engine starts when every capacity slot has an active turn', async (t) => {
    const { ctx, env, repos } = setup(t, false, { ZEDPSTACK_ACP_MAX_ENGINES: '2' });
    const ids = [];
    for (const cwd of repos.slice(0, 2)) ids.push((await ctx.rpc('session/new', { cwd, mcpServers: [] })).sessionId);
    const engines = ids.map((sessionId) => engineForSession(ctx, env, sessionId));
    const turns = ids.map((sessionId) => pendingPrompt(ctx, sessionId, 'SLEEP'));
    await waitFor(() => readTrace(env.FAKE_ACP_TRACE).filter((entry) => entry.method === 'session/prompt').length === 2, 'both active turns');
    const extra = await Promise.all(repos.slice(2).map((cwd) => ctx.rpc('session/new', { cwd, mcpServers: [] })));
    assert.equal(extra.length, 2);
    assert.ok(ctx.engines.filter((engine) => isProcessAlive(engine.pid)).length <= 2, 'active engines consume all capacity');
    assert.ok(engines.every((engine) => isProcessAlive(engine.pid)));
    assert.deepEqual(turns.map((turn) => turn.settled), [false, false]);
    for (const sessionId of ids) await ctx.hub.notify({ method: 'session/cancel', params: { sessionId } });
    assert.deepEqual((await Promise.all(turns.map((turn) => turn.promise))).map((result) => result.stopReason), ['cancelled', 'cancelled']);
  });
});

async function runResourceFixture(t, mode, repo) {
  const home = shortHome('zp-res-');
  const child = spawn(process.execPath, [RESOURCE_FIXTURE, mode, repo], {
    env: childEnv(engineEnv({ ZEDPSTACK_HOME: home, FAKE_ACP_MCP: '1' })),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 25_000);
  t.after(() => {
    clearTimeout(watchdog);
    child.kill('SIGKILL');
  });
  const exited = await completed;
  clearTimeout(watchdog);
  assert.deepEqual(exited, { code: 0, signal: null }, `${mode} fixture failed or timed out\n${stderr}\n${stdout}`);
  const report = JSON.parse(stdout.trim());
  assert.ok(report.enginePids.length > 0);
  await waitFor(() => [...report.enginePids, ...report.mcpPids].every((pid) => !isProcessAlive(pid)), 'all child processes gone', 5000);
  assert.ok(!fs.existsSync(report.bridgePath), 'shutdown removes the bridge socket');
  assert.equal(report.liveTimers, 0, 'including unref timers');
  assert.equal(report.liveChildPids.length, 0);
  return report;
}

describe('ACP resources in a dedicated process', { timeout: 35_000 }, () => {
  it('shuts down four engines and their MCP children, then exits by itself', async (t) => {
    const sb = makeSandbox();
    const report = await runResourceFixture(t, 'shutdown', sb.repo);
    assert.equal(report.enginePids.length, 4);
    assert.equal(report.mcpPids.length, 4);
    assert.equal(report.hadFourTurns, true);
  });

  it('opens and closes 50 sessions without handle, timer or child-process growth', async (t) => {
    const sb = makeSandbox();
    const report = await runResourceFixture(t, 'loop', sb.repo);
    assert.equal(report.enginePids.length, 50);
    assert.equal(report.closedSessions, 50);
    assert.ok(report.handleCounts.every((count) => count <= report.baselineHandles), JSON.stringify(report));
    assert.ok(report.timerCounts.every((count) => count === 0), JSON.stringify(report));
  });
});
