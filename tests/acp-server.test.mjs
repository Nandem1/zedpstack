import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { closeAgent } from '../src/agents/lifecycle.mjs';
import { isProcessAlive, loadAgent } from '../src/agents/store.mjs';
import { createSessionStore, handleAcpNotification, handleAcpRequest, runSpawnTurn } from '../src/acp/server.mjs';
import { THROTTLE_MS } from '../src/acp/updates.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';
import { childEnv } from './helpers/env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_AGENT = path.join(ROOT, 'tests', 'fixtures', 'bin', 'fake-acp-agent.cjs');

function fakeEngineEnv(extra = {}) {
  const cmd = JSON.stringify([process.execPath, FAKE_AGENT]);
  return {
    ZEDPSTACK_ACP_ENGINE_CLAUDE: cmd,
    ZEDPSTACK_ACP_ENGINE_CODEX: cmd,
    ZEDPSTACK_ACP_ENGINE_CURSOR: cmd,
    ...extra,
  };
}

function startAcpServer(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'acp.mjs')], {
    env: childEnv(fakeEngineEnv(extraEnv)),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const stdoutLines = [];
  const updates = [];
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    stdoutLines.push(line);
    const msg = JSON.parse(line);
    if (msg.method === 'session/update') updates.push(msg.params);
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let next = 1;
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { child, rpc, notify, updates, stdoutLines };
}

function updatesForSession(updates, sessionId) {
  return updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
}

describe('handleAcpRequest usage', () => {
  it('clears activeTurn after a usage turn', async () => {
    const sessions = createSessionStore();
    const sessionId = sessions.create(process.cwd());
    const res = await handleAcpRequest(
      {
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'not a command' }] },
      },
      { sessions, env: process.env, notify: () => {} },
    );
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(sessions.get(sessionId).activeTurn, null);
  });
});

describe('ACP spawn cancellation', () => {
  it('stops workers registered after cancellation and tolerates close failures', async (t) => {
    const sb = makeSandbox();
    const sessions = createSessionStore();
    const sessionId = sessions.create(sb.repo);
    const controller = new AbortController();
    const turn = { agentIds: ['missing-agent'], controller };
    sessions.setActiveTurn(sessionId, turn);
    t.after(async () => {
      await Promise.all(turn.agentIds.map((id) => closeAgent({ repo: sb.repo, id }).catch(() => {})));
    });

    await handleAcpNotification({ method: 'session/cancel', params: { sessionId } }, { sessions });
    const { agentIds } = await runSpawnTurn({
      sessions,
      sessionId,
      repo: sb.repo,
      command: { count: 2, role: 'how explorer', prompt: 'FAKE_SLEEP' },
      notify: () => {},
      signal: controller.signal,
      streamMode: 'content',
    });

    assert.equal(agentIds.length, 2);
    for (const id of agentIds) {
      const agent = loadAgent(sb.repo, id);
      assert.equal(agent.status, 'stopped', `${id} stopped before the turn settles`);
      assert.equal(isProcessAlive(agent.launch.runnerPid), false, `${id} runner exited`);
      assert.equal(isProcessAlive(agent.run?.workerPid), false, `${id} worker exited`);
    }
  });
});

describe('ACP server', () => {
  let sb;
  let server;

  before(() => {
    sb = makeSandbox();
    server = startAcpServer();
  });
  after(() => server.child.kill());

  it('initialize returns protocol v1', async () => {
    const res = await server.rpc('initialize', { protocolVersion: 1, clientInfo: { name: 't' } });
    assert.equal(res.result.protocolVersion, 1);
    assert.ok(res.result.agentCapabilities);
    assert.deepEqual(res.result.authMethods, []);
  });

  it('session/new returns sessionId', async () => {
    const res = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.match(res.result.sessionId, /^sess-/);
  });

  it('session/new emits available_commands_update after the response line', async () => {
    const lineBefore = server.stdoutLines.length;
    const res = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = res.result.sessionId;
    for (let i = 0; i < 50; i += 1) {
      const haveCmd = server.updates.some(
        (u) =>
          u.sessionId === sessionId && u.update?.sessionUpdate === 'available_commands_update',
      );
      if (haveCmd) break;
      await new Promise((r) => setImmediate(r));
    }
    const allParsed = server.stdoutLines.map((l) => JSON.parse(l));
    const responseLine = allParsed.findIndex((m) => m.result?.sessionId === sessionId);
    assert.ok(responseLine >= 0, 'session/new response on stdout');
    const noteLine = allParsed.findIndex(
      (m, i) =>
        i > responseLine &&
        m.method === 'session/update' &&
        m.params?.sessionId === sessionId &&
        m.params?.update?.sessionUpdate === 'available_commands_update',
    );
    assert.ok(noteLine > responseLine, 'available_commands_update after session/new response');
    assert.deepEqual(
      allParsed[noteLine].params.update.availableCommands.map((c) => c.name),
      ['claude', 'codex', 'cursor', 'board', 'spawn', 'help', 'compact'],
    );
    const promptIdx = server.stdoutLines.length;
    await server.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    const cmdsBeforePrompt = server.stdoutLines
      .slice(lineBefore, promptIdx)
      .map((l) => JSON.parse(l))
      .filter(
        (m) =>
          m.params?.sessionId === sessionId &&
          m.params?.update?.sessionUpdate === 'available_commands_update',
      );
    assert.equal(cmdsBeforePrompt.length, 1);
  });

  it('plain spawn without slash runs a worker', async () => {
    const session = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.result.sessionId;
    const before = server.updates.length;
    const res = await server.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'spawn x2 how explorer :: plain header' }],
    });
    assert.equal(res.result.stopReason, 'end_turn');
    const u = updatesForSession(server.updates.slice(before), sessionId);
    assert.equal(u.filter((x) => x.sessionUpdate === 'tool_call').length, 2);
  });

  it('unknown method is -32601', async () => {
    const res = await server.rpc('nope/method');
    assert.equal(res.error.code, -32601);
  });

  it('stdout is only JSON lines', async () => {
    for (const line of server.stdoutLines) {
      assert.ok(line.trim());
      JSON.parse(line);
    }
  });

  it('/spawn streams tool_call then updates then completed', async () => {
    const session = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.result.sessionId;
    const before = server.updates.length;
    const res = await server.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/spawn how explorer :: trace x' }],
    });
    assert.equal(res.result.stopReason, 'end_turn');
    const u = updatesForSession(server.updates.slice(before), sessionId);
    const toolCalls = u.filter((x) => x.sessionUpdate === 'tool_call');
    assert.equal(toolCalls.length, 1);
    assert.match(toolCalls[0].toolCallId, /^zp-/);
    const inProgress = u.filter((x) => x.sessionUpdate === 'tool_call_update' && x.status === 'in_progress');
    assert.ok(inProgress.length >= 1);
    const completed = u.filter((x) => x.sessionUpdate === 'tool_call_update' && x.status === 'completed');
    assert.equal(completed.length, 1);
    const order = u.map((x) => x.sessionUpdate + (x.status ? `:${x.status}` : ''));
    const firstCall = order.indexOf('tool_call');
    const firstProg = order.findIndex((x) => x.startsWith('tool_call_update:in_progress'));
    const lastDone = order.findLastIndex((x) => x === 'tool_call_update:completed');
    assert.ok(firstCall < firstProg && firstProg < lastDone);
  });

  it('/spawn x10 yields ten completed tool calls', async () => {
    const session = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.result.sessionId;
    const before = server.updates.length;
    const res = await server.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/spawn x10 how explorer :: parallel' }],
    });
    assert.equal(res.result.stopReason, 'end_turn');
    const u = updatesForSession(server.updates.slice(before), sessionId);
    const ids = new Set(u.filter((x) => x.sessionUpdate === 'tool_call').map((x) => x.toolCallId));
    assert.equal(ids.size, 10);
    const done = u.filter((x) => x.sessionUpdate === 'tool_call_update' && x.status === 'completed');
    assert.equal(done.length, 10);
  });

  it('throttle limits tool_call_update count during a turn', async () => {
    const session = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.result.sessionId;
    const t0 = Date.now();
    const before = server.updates.length;
    await server.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/spawn how explorer :: lots of stream' }],
    });
    const elapsed = Date.now() - t0;
    const u = updatesForSession(server.updates.slice(before), sessionId);
    const updatesOnly = u.filter((x) => x.sessionUpdate === 'tool_call_update');
    const maxExpected = Math.ceil(elapsed / THROTTLE_MS) * 2 + 4;
    assert.ok(updatesOnly.length <= maxExpected, `updates=${updatesOnly.length} max=${maxExpected}`);
  });

  it('session/cancel stops a sleeping worker', async () => {
    const session = await server.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.result.sessionId;
    const callsBefore = sb.cliCalls().length;
    const promptPromise = server.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/spawn x3 how explorer :: FAKE_SLEEP' }],
    });
    let calls = [];
    for (let i = 0; i < 500; i += 1) {
      calls = updatesForSession(server.updates, sessionId).filter((u) => u.sessionUpdate === 'tool_call');
      if (calls.length === 3 && sb.cliCalls().length >= callsBefore + 3) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls.length, 3, 'all workers announced before cancellation');
    assert.equal(sb.cliCalls().length, callsBefore + 3, 'all sleeping workers started');
    server.notify('session/cancel', { sessionId });
    server.notify('session/cancel', { sessionId });
    const res = await promptPromise;
    assert.equal(res.result.stopReason, 'cancelled');
    for (const call of calls) {
      const agent = loadAgent(sb.repo, call.toolCallId.slice(3));
      const { id } = agent.spec;
      assert.equal(agent.status, 'stopped', `${id} stopped before cancelled response`);
      assert.equal(isProcessAlive(agent.launch.runnerPid), false, `${id} runner exited`);
      assert.equal(isProcessAlive(agent.run?.workerPid), false, `${id} worker exited`);
    }
  });
});
