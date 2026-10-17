import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { askHuman } from '../src/acp/bridge.mjs';
import { spawnAgent, stopAgent, waitAgents } from '../src/agents/lifecycle.mjs';
import { TERMINAL_AGENT_STATUSES, listAgentIds, loadAgent } from '../src/agents/store.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userText = (text) => [{ type: 'text', text }];

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const chunks = (updates, sessionId, from = 0) => updates.slice(from)
  .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
  .map((u) => u.update.content.text);
const readTrace = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);

/**
 * A hub whose simulated Zed answers each zedpstack permission prompt from `answers`
 * (an option id, or 'hold' to leave it unanswered).
 */
function permissionHub(t, env) {
  const answers = [];
  const ctx = connectHub(t, env, {
    log: () => {},
    clientRequest: (method, params) => {
      if (method !== 'session/request_permission' || !params.toolCall.toolCallId.startsWith('zp-perm-')) return undefined;
      const answer = answers.shift() ?? 'reject_once';
      if (answer === 'hold') return new Promise(() => {});
      return { outcome: { outcome: 'selected', optionId: answer } };
    },
  });
  const asks = () => ctx.clientRequests.filter((r) => r.method === 'session/request_permission'
    && r.params.toolCall.toolCallId.startsWith('zp-perm-'));
  const ask = (sessionId, fields) => askHuman({
    title: 't',
    ...fields,
    env: { ZEDPSTACK_ACP_BRIDGE: ctx.hub.bridgePath, ZEDPSTACK_ACP_SESSION: sessionId },
  });
  const permUpdates = (toolCallId) => ctx.updates
    .filter((u) => u.update.sessionUpdate === 'tool_call_update' && u.update.toolCallId === toolCallId)
    .map((u) => u.update.status);
  return { ...ctx, answers, asks, ask, permUpdates };
}

function hubEnv(extra = {}) {
  const home = shortHome('zp-perm-');
  return childEnv(engineEnv({
    ZEDPSTACK_HOME: home,
    FAKE_ACP_MCP: '1',
    FAKE_ACP_TRACE: path.join(home, 'calls.jsonl'),
    ...extra,
  }));
}

async function stopLeftovers(repo) {
  const live = listAgentIds(repo).filter((id) => !TERMINAL_AGENT_STATUSES.has(loadAgent(repo, id).status));
  await Promise.all(live.map((id) => stopAgent({ repo, id })));
}

describe('acp hub: zedpstack action permissions', () => {
  let sb;
  let ctx;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    ctx = permissionHub(t, hubEnv());
  });

  afterEach(() => stopLeftovers(sb.repo));

  it('asks Zed in the outer session during a turn: allow_once allows, reject_once denies', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const turn = ctx.rpc('session/prompt', { sessionId, prompt: userText('SLEEP') });
    await sleep(50);

    ctx.answers.push('allow_once', 'reject_once');
    const allowed = await ctx.ask(sessionId, { action: 'apply_agent_changes', agentId: 'w-1', title: 'Aplicar w-1', detail: 'Commit: abc' });
    const denied = await ctx.ask(sessionId, { action: 'apply_agent_changes', agentId: 'w-1', title: 'Aplicar w-1', detail: 'Commit: abc' });
    assert.deepEqual([allowed, denied], [{ allowed: true }, { allowed: false, reason: 'rechazado por el usuario' }]);

    const [first, second] = ctx.asks();
    assert.equal(first.params.sessionId, sessionId);
    assert.deepEqual(first.params.toolCall, {
      toolCallId: first.params.toolCall.toolCallId,
      title: 'Aplicar w-1',
      kind: 'edit',
      status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: 'Commit: abc' } }],
    });
    assert.match(first.params.toolCall.toolCallId, /^zp-perm-\d+$/);
    assert.notEqual(first.params.toolCall.toolCallId, second.params.toolCall.toolCallId);
    assert.deepEqual(first.params.options.map((o) => [o.optionId, o.kind]), [
      ['allow_once', 'allow_once'], ['allow_always', 'allow_always'], ['reject_once', 'reject_once'],
    ]);
    assert.deepEqual(ctx.permUpdates(first.params.toolCall.toolCallId), ['completed']);
    assert.deepEqual(ctx.permUpdates(second.params.toolCall.toolCallId), ['failed']);

    ctx.notify('session/cancel', { sessionId });
    assert.equal((await turn).stopReason, 'cancelled');
  });

  it('allow_always holds for the same action only, and is gone after session close', async () => {
    const a = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    ctx.answers.push('allow_always');
    assert.equal((await ctx.ask(a.sessionId, { action: 'apply_agent_changes' })).allowed, true);
    assert.equal((await ctx.ask(a.sessionId, { action: 'apply_agent_changes' })).allowed, true);
    assert.equal(ctx.asks().length, 1, 'the second apply did not ask');

    ctx.answers.push('reject_once');
    assert.equal((await ctx.ask(a.sessionId, { action: 'close_agent' })).allowed, false);
    assert.equal(ctx.asks().length, 2, 'another action still asks');
    assert.equal(ctx.asks()[1].params.toolCall.kind, 'delete');

    const b = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    ctx.answers.push('reject_once');
    assert.equal((await ctx.ask(b.sessionId, { action: 'apply_agent_changes' })).allowed, false, 'other threads ask');

    await ctx.rpc('session/close', { sessionId: a.sessionId });
    const afterClose = await ctx.ask(a.sessionId, { action: 'apply_agent_changes' });
    assert.equal(afterClose.allowed, false);
    assert.match(afterClose.reason, /sesión desconocida/);
    assert.equal(ctx.asks().length, 3, 'a closed or unknown session never reaches Zed');
  });

  it('concurrent asks are answered independently', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    ctx.answers.push('reject_once', 'allow_once', 'reject_once', 'allow_once');
    const verdicts = await Promise.all(['a', 'b', 'c', 'd'].map((agentId) =>
      ctx.ask(sessionId, { action: 'apply_agent_changes', agentId, title: agentId })));
    const byTitle = Object.fromEntries(ctx.asks().map((r, i) => [r.params.toolCall.title, i]));
    const expected = ['a', 'b', 'c', 'd'].map((id) => byTitle[id] % 2 === 1);
    assert.deepEqual(verdicts.map((v) => v.allowed), expected);
  });

  it('a cancelled turn denies the pending ask and the prompt answers cancelled', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const turn = ctx.rpc('session/prompt', { sessionId, prompt: userText('SLEEP') });
    await sleep(50);
    ctx.answers.push('hold');
    const pending = ctx.ask(sessionId, { action: 'apply_agent_changes' });
    await waitFor(() => ctx.asks().length === 1, 'asked');
    ctx.notify('session/cancel', { sessionId });
    assert.deepEqual(await pending, { allowed: false, reason: 'el turno se canceló' });
    assert.equal((await turn).stopReason, 'cancelled');
    assert.deepEqual(ctx.permUpdates(ctx.asks()[0].params.toolCall.toolCallId), ['failed']);
  });

  it('an engine crash and a hub shutdown deny pending asks', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const turn = ctx.rpc('session/prompt', { sessionId, prompt: userText('SLEEP') });
    await sleep(50);
    ctx.answers.push('hold', 'hold');
    const beforeCrash = ctx.ask(sessionId, { action: 'apply_agent_changes' });
    await waitFor(() => ctx.asks().length === 1, 'asked');
    process.kill(ctx.engines[0].pid, 'SIGKILL');
    assert.deepEqual(await beforeCrash, { allowed: false, reason: 'el engine terminó' });
    assert.equal((await turn).stopReason, 'refusal');

    const beforeShutdown = ctx.ask(sessionId, { action: 'apply_agent_changes' });
    await waitFor(() => ctx.asks().length === 2, 'asked again');
    await ctx.hub.shutdown();
    assert.deepEqual(await beforeShutdown, { allowed: false, reason: 'el hub se está cerrando' });
    assert.equal(fs.existsSync(ctx.hub.bridgePath), false, 'socket unlinked on shutdown');
  });
});

describe('acp hub: risky MCP tools ask through the engine\'s injected MCP', () => {
  let sb;
  let ctx;
  let env;
  const git = (...args) => spawnSync('git', args, { cwd: sb.repo, encoding: 'utf8' }).stdout.trim();

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    env = hubEnv();
    ctx = permissionHub(t, env);
  });

  afterEach(() => stopLeftovers(sb.repo));

  async function mcpCall(sessionId, name, args) {
    const before = ctx.updates.length;
    await ctx.rpc('session/prompt', { sessionId, prompt: userText(`MCPCALL ${name} ${JSON.stringify(args)}`) });
    const text = chunks(ctx.updates, sessionId, before).find((c) => c.startsWith('mcp'));
    assert.ok(text?.startsWith(`mcp:${name}:`), text);
    return JSON.parse(text.slice(`mcp:${name}:`.length));
  }

  async function finishedWriter(description) {
    const spawned = spawnAgent({ repo: sb.repo, role: 'architect runners', slot: 0, description, prompt: 'FAKE_WRITE please' });
    const { done } = await waitAgents({ repo: sb.repo, ids: [spawned.agent_id], timeoutSeconds: 20 });
    assert.equal(done[0].status, 'completed');
    return done[0];
  }

  it('apply_agent_changes: a rejection leaves the checkout untouched, allow_once cherry-picks', async () => {
    const writer = await finishedWriter('apply me');
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const target = path.join(sb.repo, 'fake-output.txt');

    ctx.answers.push('reject_once');
    const denied = await mcpCall(sessionId, 'apply_agent_changes', { agent_id: writer.agent_id, repo: sb.repo });
    assert.deepEqual(denied, {
      agent_id: writer.agent_id,
      commit: writer.changes.commit,
      applied: false,
      error: 'rejected by user',
      reason: 'rechazado por el usuario',
    });
    assert.equal(fs.existsSync(target), false);
    assert.equal(git('status', '--porcelain'), '');
    const detail = ctx.asks()[0].params.toolCall.content[0].content.text;
    assert.match(detail, new RegExp(`Agente: ${writer.agent_id}`));
    assert.match(detail, new RegExp(`Commit: ${writer.changes.commit}`));
    assert.match(detail, /A\tfake-output\.txt/);
    assert.match(detail, /1 file changed/);

    ctx.answers.push('allow_once');
    const applied = await mcpCall(sessionId, 'apply_agent_changes', { agent_id: writer.agent_id, repo: sb.repo });
    assert.equal(applied.applied, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'written by fake codex\n');

    const closed = await mcpCall(sessionId, 'close_agent', { agent_id: writer.agent_id, repo: sb.repo, remove_worktree: true, delete_branch: true });
    assert.equal(closed.worktree.removed, true);
    assert.equal(ctx.asks().length, 2, 'closing an applied writer does not ask');
    git('reset', '-q', '--hard');
    fs.rmSync(target, { force: true });
  });

  it('close_agent asks before discarding a writer that was never applied', async () => {
    const writer = await finishedWriter('discard me');
    const { worktree } = loadAgent(sb.repo, writer.agent_id).spec;
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });

    ctx.answers.push('reject_once');
    const args = { agent_id: writer.agent_id, repo: sb.repo, remove_worktree: true, delete_branch: true };
    const denied = await mcpCall(sessionId, 'close_agent', args);
    assert.deepEqual(denied, {
      agent_id: writer.agent_id, closed: false, worktree: null, error: 'rejected by user', reason: 'rechazado por el usuario',
    });
    assert.ok(fs.existsSync(worktree.path), 'worktree kept');
    assert.ok(git('rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`), 'branch kept');
    assert.equal(ctx.asks()[0].params.toolCall.kind, 'delete');

    ctx.answers.push('allow_once');
    const closed = await mcpCall(sessionId, 'close_agent', args);
    assert.equal(closed.worktree.removed, true);
    assert.equal(git('rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`), '');

    const kept = await finishedWriter('stop only');
    await mcpCall(sessionId, 'close_agent', { agent_id: kept.agent_id, repo: sb.repo });
    assert.equal(ctx.asks().length, 2, 'a close that keeps the worktree does not ask');
  });

  it('spawn_agent asks for a writer in the checkout, never for a reader or an isolated writer', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const reader = await mcpCall(sessionId, 'spawn_agent', { prompt: 'look', role: 'how explorer', readonly: true, repo: sb.repo });
    const isolated = await mcpCall(sessionId, 'spawn_agent', { prompt: 'write', role: 'architect runners', repo: sb.repo });
    assert.ok(reader.agent_id && isolated.agent_id);
    assert.equal(isolated.isolation, 'worktree');
    assert.equal(ctx.asks().length, 0);

    const agentsBefore = listAgentIds(sb.repo).length;
    ctx.answers.push('reject_once');
    const denied = await mcpCall(sessionId, 'spawn_agent', { prompt: 'FAKE_WRITE', role: 'architect runners', isolation: 'none', repo: sb.repo });
    assert.deepEqual(denied, {
      agent_id: null, spawned: false, isolation: 'none', cwd: sb.repo, error: 'rejected by user', reason: 'rechazado por el usuario',
    });
    assert.equal(listAgentIds(sb.repo).length, agentsBefore, 'no agent created');
    assert.equal(ctx.asks()[0].params.toolCall.kind, 'execute');

    ctx.answers.push('allow_once');
    const inPlace = await mcpCall(sessionId, 'spawn_agent', { prompt: 'in place', role: 'architect runners', isolation: 'none', repo: sb.repo });
    assert.equal(inPlace.isolation, 'none');
    assert.equal(inPlace.cwd, sb.repo);
  });

  it('setup_write asks unless it is a dry run', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sheet = fs.readFileSync(sb.sheetPath, 'utf8');
    ctx.answers.push('reject_once');
    const denied = await mcpCall(sessionId, 'setup_write', { default_effort: 'high', roles: {} });
    assert.deepEqual(denied, { written: false, changed: false, error: 'rejected by user', reason: 'rechazado por el usuario' });
    assert.equal(fs.readFileSync(sb.sheetPath, 'utf8'), sheet);
    const dry = await mcpCall(sessionId, 'setup_write', { default_effort: 'high', roles: {}, dry_run: true });
    assert.equal(dry.written, false);
    assert.equal(ctx.asks().length, 1);
  });

  it('an unreachable bridge fails closed: nothing is applied', async (t) => {
    const writer = await finishedWriter('unreachable');
    const local = permissionHub(t, env);
    const { sessionId } = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    fs.rmSync(local.hub.bridgePath);
    const before = local.updates.length;
    await local.rpc('session/prompt', { sessionId, prompt: userText(`MCPCALL apply_agent_changes ${JSON.stringify({ agent_id: writer.agent_id, repo: sb.repo })}`) });
    const result = JSON.parse(chunks(local.updates, sessionId, before)[0].slice('mcp:apply_agent_changes:'.length));
    assert.equal(result.applied, false);
    assert.match(result.reason, /permission bridge unreachable/);
    assert.equal(fs.existsSync(path.join(sb.repo, 'fake-output.txt')), false);
  });
});

describe('acp hub: orchestrator edit guard', () => {
  let sb;
  let ctx;
  let env;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    env = hubEnv({ FAKE_ACP_FS_WRITE: '1', FAKE_ACP_TERMINAL: '1' });
    ctx = permissionHub(t, env);
  });

  async function say(sessionId, text) {
    const before = ctx.updates.length;
    await ctx.rpc('session/prompt', { sessionId, prompt: userText(text) });
    return chunks(ctx.updates, sessionId, before).filter((c) => /^(fs|term):/.test(c) || !c.startsWith('chunk-'));
  }

  const forwarded = (method) => ctx.clientRequests.filter((r) => r.method === method).map((r) => r.params.path ?? r.params.args?.at(-1));

  it('refuses repo writes, passes the rest, and /edits on|off toggles it per session', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const commands = ctx.updates.findLast((u) => u.update.sessionUpdate === 'available_commands_update');
    assert.ok(commands.update.availableCommands.some((c) => c.name === 'edits'));

    const inside = path.join(sb.repo, 'src', 'new.txt');
    const outside = path.join(shortHome('zp-out-'), 'x.txt');
    const internal = path.join(sb.repo, '.zedpstack', 'notes.txt');
    const refused = /^fs:error:el orquestador no edita archivos: delega con spawn_agent \(o \/edits on\)/;

    assert.match((await say(sessionId, `WRITE=${inside}`))[0], refused);
    assert.match((await say(sessionId, 'WRITE=src/relative.txt'))[0], refused);
    assert.deepEqual(await say(sessionId, `WRITE=${outside}`), ['fs:ok']);
    assert.deepEqual(await say(sessionId, `WRITE=${internal}`), ['fs:ok']);
    assert.match((await say(sessionId, `TERM=echo hi > ${path.join(sb.repo, 'out.txt')}`))[0], /^term:error:el orquestador no edita archivos/);
    assert.match((await say(sessionId, 'TERM=sed -i s/x/y/ src/index.mjs'))[0], /^term:error:/);
    assert.deepEqual(await say(sessionId, 'TERM=ls -la'), ['term:ok']);
    assert.deepEqual(forwarded('fs/write_text_file'), [outside, internal], 'refused writes never reach Zed');
    assert.deepEqual(forwarded('terminal/create'), ['ls -la']);

    const other = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.deepEqual(await say(sessionId, '/edits on'), [
      'Ediciones directas del orquestador permitidas en este hilo. `/edits off` las bloquea de nuevo.',
    ]);
    assert.deepEqual(await say(sessionId, `WRITE=${inside}`), ['fs:ok']);
    assert.deepEqual(await say(sessionId, `TERM=echo hi > ${path.join(sb.repo, 'out.txt')}`), ['term:ok']);
    assert.match((await say(other.sessionId, `WRITE=${inside}`))[0], refused, 'the switch is per session');

    assert.match((await say(sessionId, '/edits'))[0], /permitidas/);
    assert.match((await say(sessionId, '/edits off'))[0], /bloqueadas/);
    assert.match((await say(sessionId, `WRITE=${inside}`))[0], refused);

    const linked = path.join(shortHome('zp-link-'), 'repo');
    fs.symlinkSync(sb.repo, linked);
    const viaLink = await ctx.rpc('session/new', { cwd: linked, mcpServers: [] });
    assert.match((await say(viaLink.sessionId, `WRITE=${inside}`))[0], refused, 'the real path of a symlinked cwd is still the repo');
    assert.match((await say(sessionId, `WRITE=${path.join(linked, 'src', 'x.txt')}`))[0], refused, 'and a symlinked target too');

    const prompts = readTrace(env.FAKE_ACP_TRACE).filter((c) => c.method === 'session/prompt').map((c) => c.params.prompt.at(-1).text);
    assert.ok(!prompts.some((text) => text.startsWith('/edits')), '/edits is handled by the hub');
    assert.ok(fs.existsSync(path.join(sb.repo, '.zedpstack', '.gitignore')), 'the audit stays out of git status');
  });
});
