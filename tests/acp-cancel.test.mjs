import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ZP_RUNTIME_ID } from '../src/acp/options.mjs';
import { stopAgent } from '../src/agents/lifecycle.mjs';
import { TERMINAL_AGENT_STATUSES, isProcessAlive, listAgentIds, loadAgent } from '../src/agents/store.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const userText = (text) => [{ type: 'text', text }];
const chunks = (updates, sessionId, from = 0) => updates.slice(from)
  .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
  .map((u) => u.update.content.text);
const spawnedIds = (updates, sessionId) => chunks(updates, sessionId)
  .filter((text) => text.startsWith('spawned:'))
  .map((text) => text.slice('spawned:'.length));
const cardEnded = (updates, id) => updates.some((u) => u.update.toolCallId === `zp-${id}`
  && u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'failed');
const readTrace = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);

function sessionAgents(repo, sessionId, sinceMs = 0) {
  return listAgentIds(repo)
    .map((id) => loadAgent(repo, id))
    .filter((v) => v.spec.origin?.sessionId === sessionId && Date.parse(v.spec.createdAt) >= sinceMs);
}

const workerPids = (view) => [view.run?.workerPid, view.run?.runnerPid ?? view.launch?.runnerPid].filter(Boolean);

async function stopLeftovers(repo) {
  const live = listAgentIds(repo).filter((id) => !TERMINAL_AGENT_STATUSES.has(loadAgent(repo, id).status));
  await Promise.all(live.map((id) => stopAgent({ repo, id })));
}

describe('acp cancel and engine supervision (in-process hub)', () => {
  let sb;
  let env;
  let ctx;
  let logs;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    const home = shortHome('zp-cancel-home-');
    env = childEnv(engineEnv({
      ZEDPSTACK_HOME: home,
      FAKE_ACP_MCP: '1',
      FAKE_ACP_TRACE: path.join(home, 'calls.jsonl'),
    }));
    logs = [];
    ctx = connectHub(t, env, { log: (line) => logs.push(line) });
  });

  afterEach(() => stopLeftovers(sb.repo));

  it('cancel stops only this turn\'s workers, closes their cards, then answers cancelled', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.equal((await ctx.rpc('session/prompt', { sessionId, prompt: userText('SPAWN FAKE_SLEEP earlier') })).stopReason, 'end_turn');
    const [earlier] = spawnedIds(ctx.updates, sessionId);
    await waitFor(() => loadAgent(sb.repo, earlier).status === 'running', 'earlier worker running');

    const pending = ctx.rpc('session/prompt', { sessionId, prompt: userText('SPAWN FAKE_SLEEP SLEEP') });
    await waitFor(() => spawnedIds(ctx.updates, sessionId).length === 2, 'second spawn');
    const current = spawnedIds(ctx.updates, sessionId)[1];
    await waitFor(() => loadAgent(sb.repo, current).status === 'running', 'current worker running');
    const currentPids = workerPids(loadAgent(sb.repo, current));

    ctx.notify('session/cancel', { sessionId });
    const atResponse = await pending.then((result) => ({
      stopReason: result.stopReason,
      status: loadAgent(sb.repo, current).status,
      processesAlive: currentPids.some(isProcessAlive),
      cardEnded: cardEnded(ctx.updates, current),
    }));
    assert.deepEqual(atResponse, { stopReason: 'cancelled', status: 'stopped', processesAlive: false, cardEnded: true });

    const childSession = ctx.engines[0].childSessionId;
    const cancels = readTrace(env.FAKE_ACP_TRACE).filter((c) => c.method === 'session/cancel');
    assert.deepEqual(cancels.map((c) => c.params.sessionId), [childSession]);
    assert.equal(loadAgent(sb.repo, earlier).status, 'running', 'a worker of an earlier turn keeps running');
    assert.ok(!cardEnded(ctx.updates, earlier));
  });

  it('20 cancels at random points of a spawning turn: every turn worker stopped before cancelled', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const outcomes = [];
    for (let i = 0; i < 20; i += 1) {
      const since = Date.now();
      const pending = ctx.rpc('session/prompt', { sessionId, prompt: userText(`SPAWN FAKE_SLEEP SLEEP ${i}`) });
      // The first turns cancel while the engine is still inside spawn_agent.
      await sleep(i < 4 ? i * 10 : Math.floor(Math.random() * 900));
      const spawnedBefore = spawnedIds(ctx.updates, sessionId).length;
      const first = ctx.hub.notify({ method: 'session/cancel', params: { sessionId } });
      const second = ctx.hub.notify({ method: 'session/cancel', params: { sessionId } });
      const result = await pending;
      const views = sessionAgents(sb.repo, sessionId, since);
      outcomes.push({
        cancelBeforeSpawn: spawnedIds(ctx.updates, sessionId).length > spawnedBefore,
        stopReason: result.stopReason,
        joined: first === second,
        statuses: views.map((v) => v.status),
        alive: views.some((v) => workerPids(v).some(isProcessAlive)),
        cardsEnded: views.every((v) => cardEnded(ctx.updates, v.spec.id)),
      });
    }
    for (const [i, o] of outcomes.entries()) {
      assert.deepEqual(
        { ...o, statuses: [...new Set(o.statuses)] },
        { cancelBeforeSpawn: o.cancelBeforeSpawn, stopReason: 'cancelled', joined: true, statuses: o.statuses.length ? ['stopped'] : [], alive: false, cardsEnded: true },
        `iteration ${i}: ${JSON.stringify(o)}`,
      );
    }
    const forwarded = readTrace(env.FAKE_ACP_TRACE).filter((c) => c.method === 'session/cancel').length;
    assert.equal(forwarded, 20, 'one forwarded session/cancel per turn, however many arrived');
    assert.ok(outcomes.filter((o) => o.statuses.length === 1).length >= 10, 'most turns had a worker to stop');
    assert.ok(
      outcomes.some((o) => o.cancelBeforeSpawn && o.statuses.length === 1),
      'some worker was created after the cancel arrived',
    );
  });

  it('cancel with no open turn is a no-op', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    await ctx.hub.notify({ method: 'session/cancel', params: { sessionId } });
    await ctx.hub.notify({ method: 'session/cancel', params: { sessionId: 'sess-unknown' } });
    const result = await ctx.rpc('session/prompt', { sessionId, prompt: userText('hello') });
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(!readTrace(env.FAKE_ACP_TRACE).some((c) => c.method === 'session/cancel'));
  });

  it('a permission request Zed has not answered resolves as cancelled toward the engine', async (t) => {
    const local = connectHub(t, env, {
      clientRequest: (method) => (method === 'session/request_permission' ? new Promise(() => {}) : undefined),
    });
    const { sessionId } = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const pending = local.rpc('session/prompt', { sessionId, prompt: userText('ASK') });
    await waitFor(() => local.clientRequests.some((r) => r.method === 'session/request_permission'), 'permission asked');
    local.notify('session/cancel', { sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
    assert.ok(chunks(local.updates, sessionId).includes('perm:cancelled'));
  });

  it('an engine dying mid-turn answers refusal, then the next prompt restarts it once with a lost notice', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const before = ctx.updates.length;
    const crashed = await ctx.rpc('session/prompt', { sessionId, prompt: userText('CRASH') });
    assert.equal(crashed.stopReason, 'refusal');
    const [notice] = chunks(ctx.updates, sessionId, before);
    assert.match(notice, /código 42/);
    assert.match(notice, /engine exploded mid-turn/);

    const { configOptions } = await ctx.rpc('session/set_config_option', { sessionId, configId: 'model', value: 'beta' });
    assert.equal(configOptions.find((o) => o.id === ZP_RUNTIME_ID).currentValue, 'claude');

    const afterCrash = ctx.updates.length;
    const next = ctx.rpc('session/prompt', { sessionId, prompt: userText('hello again') });
    await assert.rejects(
      () => ctx.rpc('session/prompt', { sessionId, prompt: userText('impatient') }),
      (e) => e.rpc === -32602,
    );
    assert.equal((await next).stopReason, 'end_turn');
    assert.deepEqual(chunks(ctx.updates, sessionId, afterCrash), [
      'El engine anterior terminó y la conversación anterior se perdió. Se inicia un engine nuevo.',
      'chunk-1',
      'chunk-2',
    ]);
    assert.equal(ctx.engines.length, 2, 'exactly one replacement engine');
    const prompts = readTrace(env.FAKE_ACP_TRACE).filter((c) => c.method === 'session/prompt');
    assert.deepEqual(prompts.map((c) => [c.pid, c.params.prompt.length]), [
      [ctx.engines[0].pid, 2],
      [ctx.engines[1].pid, 2],
    ]);
  });

  it('session/close kills that engine and forgets the session', async () => {
    const a = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const b = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const [engineA, engineB] = ctx.engines;
    assert.deepEqual(await ctx.rpc('session/close', { sessionId: a.sessionId }), {});
    assert.deepEqual(await ctx.rpc('session/close', { sessionId: a.sessionId }), {});
    assert.equal(isProcessAlive(engineA.pid), false);
    assert.equal(isProcessAlive(engineB.pid), true);
    await assert.rejects(
      () => ctx.rpc('session/prompt', { sessionId: a.sessionId, prompt: userText('x') }),
      (e) => e.rpc === -32602,
    );
    assert.equal((await ctx.rpc('session/prompt', { sessionId: b.sessionId, prompt: userText('x') })).stopReason, 'end_turn');
  });

  it('the engine cap stops the least recently used idle engine, which restarts lazily', async (t) => {
    const local = connectHub(t, { ...env, ZEDPSTACK_ACP_MAX_ENGINES: '2' }, { log: (line) => logs.push(line) });
    const a = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const b = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    await local.rpc('session/prompt', { sessionId: a.sessionId, prompt: userText('touch a') });
    const c = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const [engineA, engineB, engineC] = local.engines;
    await waitFor(() => !isProcessAlive(engineB.pid), 'b evicted');
    assert.deepEqual([engineA, engineC].map((e) => isProcessAlive(e.pid)), [true, true]);
    assert.ok(logs.some((line) => line.includes(b.sessionId)));

    const before = local.updates.length;
    assert.equal((await local.rpc('session/prompt', { sessionId: b.sessionId, prompt: userText('back') })).stopReason, 'end_turn');
    assert.match(chunks(local.updates, b.sessionId, before)[0], /conversación anterior se perdió/);
    await waitFor(() => !isProcessAlive(engineA.pid), 'a evicted next: c was used more recently');
    assert.deepEqual([engineC, local.engines[3]].map((e) => isProcessAlive(e.pid)), [true, true]);
    assert.equal(local.engines.length, 4);
    assert.ok(c.sessionId);
  });
});

function spawnHub(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'acp.mjs')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates = [];
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'session/update') updates.push(msg.params);
    else if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let next = 1;
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, rpc, updates, exited, stderr: () => stderr };
}

describe('acp hub process supervision', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
  });
  afterEach(() => stopLeftovers(sb.repo));

  function hubEnv(extra = {}) {
    const home = shortHome('zp-super-');
    return childEnv(engineEnv({
      ZEDPSTACK_HOME: home,
      FAKE_ACP_MCP: '1',
      FAKE_ACP_IGNORE_EOF: '1',
      FAKE_ACP_TRACE: path.join(home, 'calls.jsonl'),
      ...extra,
    }));
  }

  const enginePid = (env) => readTrace(env.FAKE_ACP_TRACE).find((c) => c.method === 'session/new').pid;

  it('a SIGKILLed hub mid-turn still takes down its engine and the MCP child', async (t) => {
    const env = hubEnv();
    const hub = spawnHub(env);
    t.after(() => hub.child.kill('SIGKILL'));
    await hub.rpc('initialize', { protocolVersion: 1 });
    const { sessionId } = (await hub.rpc('session/new', { cwd: sb.repo, mcpServers: [] })).result;
    hub.rpc('session/prompt', { sessionId, prompt: userText('MCPHOLD SLEEP') });
    await waitFor(() => chunks(hub.updates, sessionId).some((c) => c.startsWith('mcp:')), 'mcp held');
    const mcpPid = Number(chunks(hub.updates, sessionId).find((c) => c.startsWith('mcp:')).slice(4));
    const engine = enginePid(env);
    assert.deepEqual([isProcessAlive(engine), isProcessAlive(mcpPid)], [true, true]);

    hub.child.kill('SIGKILL');
    await hub.exited;
    await waitFor(() => !isProcessAlive(engine) && !isProcessAlive(mcpPid), 'engine and mcp gone', 8000);
  });

  it('SIGTERM exits 0 with no engine process left and names the workers it leaves running', async (t) => {
    const env = hubEnv({ FAKE_ACP_STUBBORN_CHILD: '1' });
    const hub = spawnHub(env);
    t.after(() => hub.child.kill('SIGKILL'));
    await hub.rpc('initialize', { protocolVersion: 1 });
    const { sessionId } = (await hub.rpc('session/new', { cwd: sb.repo, mcpServers: [] })).result;
    await hub.rpc('session/prompt', { sessionId, prompt: userText('SPAWN FAKE_SLEEP') });
    const [worker] = spawnedIds(hub.updates, sessionId);
    hub.rpc('session/prompt', { sessionId, prompt: userText('SLEEP') });
    await sleep(100);
    const engine = enginePid(env);
    const stubborn = readTrace(env.FAKE_ACP_TRACE).find((c) => c.method === 'stubborn-child').params.pid;
    t.after(() => {
      try {
        process.kill(stubborn, 'SIGKILL');
      } catch {
        /* already gone */
      }
    });

    hub.child.kill('SIGTERM');
    assert.deepEqual(await hub.exited, { code: 0, signal: null });
    assert.deepEqual([isProcessAlive(engine), isProcessAlive(stubborn)], [false, false]);
    assert.match(hub.stderr(), new RegExp(`${sessionId}: workers left running: ${worker}`));
    assert.notEqual(loadAgent(sb.repo, worker).status, 'stopped', 'workers outlive the hub (D-03)');
    assert.ok(!TERMINAL_AGENT_STATUSES.has(loadAgent(sb.repo, worker).status));
  });
});

describe('MCP parent watchdog', () => {
  function startMcp(env) {
    const mcp = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mcp.mjs')], {
      env: childEnv(env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = [];
    readline.createInterface({ input: mcp.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
    const exited = new Promise((resolve) => mcp.once('exit', (code) => resolve(code)));
    return { mcp, lines, exited };
  }

  it('stays up while ZEDPSTACK_PARENT_PID lives and exits once it dies', async (t) => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => parent.kill('SIGKILL'));
    const { mcp, lines, exited } = startMcp({ ZEDPSTACK_PARENT_PID: String(parent.pid) });
    t.after(() => mcp.kill('SIGKILL'));
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await waitFor(() => lines.some((l) => l.id === 1), 'ping answered');
    await sleep(2500);
    assert.equal(mcp.exitCode, null, 'alive while the parent lives');
    parent.kill('SIGKILL');
    const started = Date.now();
    assert.equal(await exited, 0);
    assert.ok(Date.now() - started < 5000);
  });

  it('exits on stdin EOF after answering what it already received', async () => {
    const { mcp, lines, exited } = startMcp({});
    mcp.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
    assert.equal(await exited, 0);
    assert.ok(lines.some((l) => l.id === 7 && l.result.tools.length > 0));
  });
});
