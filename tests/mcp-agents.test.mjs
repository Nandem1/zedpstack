import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './helpers/sandbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mcp.mjs')], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const notifications = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) {
      notifications.push(msg);
      return;
    }
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
  const callRaw = (name, args, meta) => rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const call = async (name, args) => {
    const res = await callRaw(name, args);
    const text = res.result.content.at(-1).text;
    if (res.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { child, rpc, call, callRaw, notifications };
}

describe('MCP server', () => {
  let sb;
  let server;
  before(() => {
    sb = makeSandbox();
    server = startServer();
  });
  after(() => server.child.kill());

  it('initializes with tools, prompts and instructions', async () => {
    const res = await server.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.ok(res.result.capabilities.tools);
    assert.match(res.result.instructions, /spawn_agent/);
    const tools = await server.rpc('tools/list');
    const names = tools.result.tools.map((t) => t.name);
    for (const n of ['spawn_agent', 'wait_agent', 'agent_result', 'close_agent', 'apply_agent_changes', 'list_models', 'read_skill']) {
      assert.ok(names.includes(n), n);
    }
  });

  it('serves /zedpstack from SKILL.md with the task appended', async () => {
    const res = await server.rpc('prompts/get', { name: 'zedpstack', arguments: { task: 'fix the login bug' } });
    const text = res.result.messages[0].content.text;
    assert.match(text, /poteto-mode/);
    assert.match(text, /## Task\n\nfix the login bug/);
    assert.doesNotMatch(text, /^---/);
  });

  it('reports unknown methods as JSON-RPC errors', async () => {
    const res = await server.rpc('nope/nope');
    assert.equal(res.error.code, -32601);
  });

  it('reads pstack skills but not paths outside them', async () => {
    const skill = await server.call('read_skill', { skill: 'poteto-mode' });
    assert.match(skill.text, /Poteto mode \(fixture\)/);
    await assert.rejects(server.call('read_skill', { skill: 'how', file: '../../models.json' }), /escapes/);
  });

  it('runs a read-only explorer from a sheet role', async () => {
    const spawned = await server.call('spawn_agent', {
      repo: sb.repo,
      role: 'how explorer',
      readonly: true,
      description: 'map index',
      prompt: 'Where is x defined?',
    });
    assert.equal(spawned.runtime, 'claude');
    assert.equal(spawned.isolation, 'none');
    const waited = await server.call('wait_agent', { repo: sb.repo, agent_ids: [spawned.agent_id], timeout_seconds: 20 });
    assert.equal(waited.timed_out, false);
    const [done] = waited.done;
    assert.equal(done.status, 'completed');
    assert.match(done.text, /model=haiku/);
    assert.match(done.text, /readonly=true/);
    const call = sb.cliCalls().find((c) => c.runtime === 'claude');
    assert.ok(call.args.includes('Read,Grep,Glob'));
    assert.ok(!call.args.includes('--force'));
  });

  it('isolates a writer in a worktree, commits, and applies on request', async () => {
    const spawned = await server.call('spawn_agent', {
      repo: sb.repo,
      role: 'architect runners',
      slot: 0,
      description: 'write file',
      prompt: 'FAKE_WRITE please',
    });
    assert.equal(spawned.runtime, 'codex');
    assert.equal(spawned.isolation, 'worktree');
    assert.notEqual(spawned.cwd, sb.repo);
    const { done } = await server.call('wait_agent', { repo: sb.repo, agent_ids: [spawned.agent_id], timeout_seconds: 20 });
    assert.equal(done[0].status, 'completed');
    assert.deepEqual(done[0].changes.files, ['A\tfake-output.txt']);
    assert.ok(!fs.existsSync(path.join(sb.repo, 'fake-output.txt')), 'host untouched before apply');

    const applied = await server.call('apply_agent_changes', { repo: sb.repo, agent_id: spawned.agent_id });
    assert.equal(applied.applied, true);
    assert.equal(fs.readFileSync(path.join(sb.repo, 'fake-output.txt'), 'utf8'), 'written by fake codex\n');

    const closed = await server.call('close_agent', { repo: sb.repo, agent_id: spawned.agent_id, remove_worktree: true, delete_branch: true });
    assert.equal(closed.worktree.removed, true);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: sb.repo, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(status, /\.zedpstack/, '.zedpstack ignores itself');
  });

  it('runs a Cursor panel slot in ask mode without --force', async () => {
    const spawned = await server.call('spawn_agent', {
      repo: sb.repo, role: 'architect runners', slot: 1, readonly: true, prompt: 'review',
    });
    assert.equal(spawned.runtime, 'cursor');
    await server.call('wait_agent', { repo: sb.repo, agent_ids: [spawned.agent_id], timeout_seconds: 20 });
    const call = sb.cliCalls().find((c) => c.runtime === 'cursor');
    assert.deepEqual(call.args.slice(call.args.indexOf('--mode'), call.args.indexOf('--mode') + 2), ['--mode', 'ask']);
    assert.ok(!call.args.includes('--force'));
  });

  it('reports a failing worker with its stderr', async () => {
    const spawned = await server.call('spawn_agent', { repo: sb.repo, model: 'haiku', readonly: true, prompt: 'FAKE_FAIL' });
    const { done } = await server.call('wait_agent', { repo: sb.repo, agent_ids: [spawned.agent_id], timeout_seconds: 20 });
    assert.equal(done[0].status, 'failed');
    assert.match(done[0].error, /exit 3/);
    assert.ok(done[0].stderr_tail.includes('fake failure'));
  });

  it('wait returns early with pending agents, and close stops them', async () => {
    const spawned = await server.call('spawn_agent', { repo: sb.repo, model: 'haiku', readonly: true, prompt: 'FAKE_SLEEP' });
    const waited = await server.call('wait_agent', { repo: sb.repo, agent_ids: [spawned.agent_id], timeout_seconds: 1 });
    assert.equal(waited.timed_out, true);
    assert.equal(waited.pending[0].agent_id, spawned.agent_id);
    const closed = await server.call('close_agent', { repo: sb.repo, agent_id: spawned.agent_id });
    assert.equal(closed.status, 'stopped');
    const listed = await server.call('list_agents', { repo: sb.repo, status: 'stopped' });
    assert.equal(listed.length, 1);
  });

  it('shows a Cursor-style board and streams progress while waiting', async () => {
    const spawned = await server.callRaw('spawn_agent', {
      repo: sb.repo, role: 'how explorer', readonly: true, description: 'How: board check', prompt: 'look',
    });
    const board = spawned.result.content[0].text;
    assert.match(board, /^zedpstack · \d+ running/);
    assert.match(board, /How: board check {2}haiku · Claude/);
    const id = JSON.parse(spawned.result.content.at(-1).text).agent_id;

    const waited = await server.callRaw(
      'wait_agent',
      { repo: sb.repo, agent_ids: [id], timeout_seconds: 20 },
      { progressToken: 'tok-1' },
    );
    assert.match(waited.result.content[0].text, /✓ How: board check {2}haiku → claude-haiku-fake · Claude\n {2}done in/);
    const progress = server.notifications.filter((n) => n.method === 'notifications/progress' && n.params.progressToken === 'tok-1');
    assert.ok(progress.length >= 1, 'at least one progress notification');
    assert.match(progress[0].params.message, /How: board check/);
  });

  it('rejects a spawn for an unknown role before creating anything', async () => {
    await assert.rejects(server.call('spawn_agent', { repo: sb.repo, role: 'wizard', prompt: 'x' }), /unknown role/);
  });
});
