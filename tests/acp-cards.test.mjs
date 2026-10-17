import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerCards } from '../src/acp/cards.mjs';
import { engineMcpServers } from '../src/acp/engine.mjs';
import { createSpec, loadAgent, writeRun } from '../src/agents/store.mjs';
import { connectHub, engineEnv } from './helpers/acpHub.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seedAgent(repo, id, { origin, finished = true, runnerPid = null }) {
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
    origin,
  });
  writeRun(repo, id, {
    runnerPid,
    workerPid: null,
    startedAt: now,
    effectiveModel: null,
    outcome: finished
      ? { ok: true, exitCode: 0, timedOut: false, error: null, changes: null, changeError: null, finishedAt: now }
      : null,
  });
  fs.writeFileSync(path.join(repo, '.zedpstack', 'agents', id, 'progress.log'), `${id} did work\n`);
}

const acpOrigin = (sessionId) => ({ frontend: 'acp', sessionId, pid: process.pid });
const cardUpdates = (updates, sessionId) => updates
  .filter((u) => u.sessionId === sessionId && u.update.toolCallId?.startsWith('zp-'))
  .map((u) => u.update);
const text = (update) => update.content?.[0]?.content?.text ?? '';

describe('engineMcpServers', () => {
  it('replaces a client zedpstack server and scopes ours to the outer session', () => {
    const other = { name: 'other', command: 'x', args: [], env: [] };
    const servers = engineMcpServers({
      clientServers: [{ name: 'zedpstack', command: 'old', args: [], env: [] }, other],
      sessionId: 'sess-1',
      repo: '/r',
    });
    assert.deepEqual(servers, [
      other,
      {
        name: 'zedpstack',
        command: process.execPath,
        args: [path.join(ROOT, 'scripts', 'mcp.mjs')],
        env: [
          { name: 'ZEDPSTACK_ACP_SESSION', value: 'sess-1' },
          { name: 'ZEDPSTACK_REPO', value: '/r' },
        ],
      },
    ]);
  });
});

describe('createWorkerCards', () => {
  let sb;
  before(() => {
    sb = makeSandbox();
  });

  it('shows a worker that finished before it was seen exactly once, however often it resyncs', async () => {
    seedAgent(sb.repo, 'done-1', { origin: acpOrigin('sess-a') });
    const updates = [];
    const cards = createWorkerCards({ repo: sb.repo, sessionId: 'sess-a', notify: (p) => updates.push(p), pollMs: 50 });
    cards.resync();
    cards.resync();
    await waitFor(() => cardUpdates(updates, 'sess-a').some((u) => u.status === 'completed'), 'completed');
    cards.resync();
    await sleep(300);
    cards.dispose();
    const seen = cardUpdates(updates, 'sess-a').map((u) => `${u.sessionUpdate}:${u.status}`);
    assert.equal(seen[0], 'tool_call:pending');
    assert.equal(seen.filter((s) => s === 'tool_call:pending').length, 1);
    assert.equal(seen.filter((s) => s === 'tool_call_update:completed').length, 1);
    assert.equal(seen.at(-1), 'tool_call_update:completed');
    assert.ok(cardUpdates(updates, 'sess-a').some((u) => u.status === 'in_progress' && text(u).includes('done-1 did work')));
  });

  it('ignores agents of another session and of another frontend', async () => {
    seedAgent(sb.repo, 'mine-1', { origin: acpOrigin('sess-b') });
    seedAgent(sb.repo, 'other-session-1', { origin: acpOrigin('sess-c') });
    seedAgent(sb.repo, 'mcp-host-1', { origin: { frontend: 'mcp', sessionId: null, pid: 1 } });
    seedAgent(sb.repo, 'cli-same-id-1', { origin: { frontend: 'cli', sessionId: 'sess-b', pid: 1 } });
    const updates = [];
    const cards = createWorkerCards({ repo: sb.repo, sessionId: 'sess-b', notify: (p) => updates.push(p), pollMs: 50 });
    cards.start();
    await waitFor(() => cardUpdates(updates, 'sess-b').some((u) => u.status === 'completed'), 'completed');
    await sleep(200);
    cards.dispose();
    assert.deepEqual(new Set(updates.map((u) => u.update.toolCallId)), new Set(['zp-mine-1']));
  });

  it('dispose clears every timer, so the process exits', () => {
    seedAgent(sb.repo, 'running-1', { origin: acpOrigin('sess-d'), finished: false, runnerPid: process.pid });
    // getActiveResourcesInfo() skips unref'd timers, so the script tracks every timer itself.
    const script = `
      const live = new Set();
      for (const [set, clear, once] of [['setTimeout', 'clearTimeout', true], ['setInterval', 'clearInterval', false]]) {
        const origSet = globalThis[set];
        const origClear = globalThis[clear];
        globalThis[set] = (fn, ...rest) => {
          const handle = origSet((...args) => { if (once) live.delete(handle); fn(...args); }, ...rest);
          live.add(handle);
          return handle;
        };
        globalThis[clear] = (handle) => { live.delete(handle); origClear(handle); };
      }
      const { createWorkerCards } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'acp', 'cards.mjs')).href)});
      const timers = () => live.size;
      const notes = [];
      const cards = createWorkerCards({ repo: ${JSON.stringify(sb.repo)}, sessionId: 'sess-d', notify: (p) => notes.push(p), pollMs: 50 });
      cards.start();
      await new Promise((r) => setTimeout(r, 400));
      const during = timers();
      cards.dispose();
      const count = notes.length;
      await new Promise((r) => setTimeout(r, 400));
      console.log(JSON.stringify({ during, after: timers(), cards: notes.length, lateNotes: notes.length - count }));
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.during >= 2, `poll and follow timers live while running: ${res.stdout}`);
    assert.ok(out.cards >= 2, `running worker got a card: ${res.stdout}`);
    assert.equal(out.after, 0);
    assert.equal(out.lateNotes, 0);
  });
});

describe('hub worker cards through the injected MCP', () => {
  let sb;
  let env;
  let ctx;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cards-home-'));
    env = childEnv(engineEnv({ ZEDPSTACK_HOME: home, FAKE_ACP_MCP: '1' }));
    ctx = connectHub(t, env);
  });

  it('hands the engine the client servers plus zedpstack scoped to the outer session', async () => {
    const user = { name: 'zedpstack', command: '/stale', args: [], env: [] };
    const other = { name: 'docs', command: '/bin/docs', args: ['--x'], env: [] };
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [user, other] });
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'MCPINFO' }] });
    const info = ctx.updates.findLast((u) => u.update.sessionUpdate === 'agent_message_chunk');
    const servers = JSON.parse(info.update.content.text);
    assert.deepEqual(servers, engineMcpServers({ clientServers: [other], sessionId, repo: sb.repo }));
  });

  it('a SPAWN turn yields one live card that keeps updating after end_turn', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const res = await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SPAWN please' }] });
    const atEndTurn = ctx.updates.length;
    assert.equal(res.stopReason, 'end_turn');
    const agentId = ctx.updates.findLast((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .update.content.text.replace('spawned:', '');
    const { frontend, sessionId: originSession } = loadAgent(sb.repo, agentId).spec.origin;
    assert.deepEqual({ frontend, originSession }, { frontend: 'acp', originSession: sessionId });

    await waitFor(() => cardUpdates(ctx.updates, sessionId).some((u) => u.status === 'completed'), 'completed card');
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    await sleep(400);

    const cards = cardUpdates(ctx.updates, sessionId);
    assert.ok(cards.every((u) => u.toolCallId === `zp-${agentId}`));
    const calls = cards.filter((u) => u.sessionUpdate === 'tool_call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'other');
    assert.equal(calls[0].status, 'pending');
    assert.ok(text(calls[0]));
    const order = cards.map((u) => `${u.sessionUpdate}:${u.status}`);
    const firstLive = cards.findIndex((u) => u.status === 'in_progress' && text(u));
    assert.ok(firstLive > 0, `in_progress with content: ${order}`);
    assert.equal(order.filter((s) => s === 'tool_call_update:completed').length, 1);
    assert.ok(firstLive < order.indexOf('tool_call_update:completed'));
    const completedAt = ctx.updates.findIndex((u) => u.update.status === 'completed');
    assert.ok(completedAt >= atEndTurn, 'the card completes after the spawning turn ended');
  });

  it('two sessions on the same repo only see their own workers', async () => {
    const a = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const b = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    await ctx.rpc('session/prompt', { sessionId: a.sessionId, prompt: [{ type: 'text', text: 'SPAWN from a' }] });
    await ctx.rpc('session/prompt', { sessionId: b.sessionId, prompt: [{ type: 'text', text: 'SPAWN from b' }] });
    const spawned = ctx.updates.filter((u) => u.update.content?.text?.startsWith('spawned:'))
      .map((u) => [u.sessionId, `zp-${u.update.content.text.slice('spawned:'.length)}`]);
    await waitFor(() => ctx.updates.filter((u) => u.update.status === 'completed').length === 2, 'both completed');
    for (const [sessionId, toolCallId] of spawned) {
      assert.deepEqual([...new Set(cardUpdates(ctx.updates, sessionId).map((u) => u.toolCallId))], [toolCallId]);
    }
  });
});

describe('scripts/acp.mjs process', () => {
  it('speaks JSON lines only and streams a card for a worker spawned by the engine', async (t) => {
    const sb = makeSandbox();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-acp-proc-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'acp.mjs')], {
      env: childEnv(engineEnv({ ZEDPSTACK_HOME: home, FAKE_ACP_MCP: '1' })),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = [];
    const pending = new Map();
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line);
      const msg = JSON.parse(line);
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(() => child.kill());
    let next = 1;
    const rpc = (method, params = {}) => new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    assert.equal((await rpc('initialize', { protocolVersion: 1 })).result.protocolVersion, 1);
    assert.equal((await rpc('nope/method')).error.code, -32601);
    const { sessionId } = (await rpc('session/new', { cwd: sb.repo, mcpServers: [] })).result;
    await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SPAWN' }] });
    const updates = () => lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'session/update').map((m) => m.params);
    await waitFor(() => cardUpdates(updates(), sessionId).some((u) => u.status === 'completed'), 'completed card');
    child.stdin.end();
    assert.equal(await exited, 0);
    for (const line of lines) JSON.parse(line);
  });
});
