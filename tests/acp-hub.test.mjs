import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/acp/hub.mjs';
import { startEngine } from '../src/acp/engine.mjs';
import { mergeCommands, ZP_RUNTIME_ID } from '../src/acp/options.mjs';
import { createPeer } from '../src/acp/rpc.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_AGENT = path.join(ROOT, 'tests', 'fixtures', 'bin', 'fake-acp-agent.cjs');

function engineEnv(extra = {}) {
  const cmd = JSON.stringify([process.execPath, FAKE_AGENT]);
  return {
    ZEDPSTACK_ACP_ENGINE_CLAUDE: cmd,
    ZEDPSTACK_ACP_ENGINE_CODEX: cmd,
    ZEDPSTACK_ACP_ENGINE_CURSOR: cmd,
    ...extra,
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function connectHub(t, env) {
  const zedToHub = new PassThrough();
  const hubToZed = new PassThrough();
  const zedSim = createPeer({ input: hubToZed, output: zedToHub, label: 'zed-sim' });
  const hubWire = createPeer({ input: zedToHub, output: hubToZed, label: 'hub-wire' });

  const updates = [];
  const clientRequests = [];
  const engines = [];

  zedSim.onRequest(async (method, params) => {
    clientRequests.push({ method, params });
    if (method === 'session/request_permission') {
      return { outcome: { outcome: 'selected', optionId: 'ok' } };
    }
    if (method === 'fs/read_text_file') {
      return { content: 'file-body' };
    }
    throw Object.assign(new Error(`unexpected zed request ${method}`), { rpc: -32601 });
  });

  const hub = createHub({
    env,
    spawnEngine: async (opts) => {
      const engine = await startEngine({ ...opts, env });
      engines.push(engine);
      return engine;
    },
    zed: {
      request: (method, params) => hubWire.request(method, params),
      notify: (params) => {
        updates.push(params);
        hubWire.notify('session/update', params);
      },
    },
  });

  t.after(async () => {
    try {
      await hub.shutdown();
    } finally {
      try {
        await Promise.all(engines.map((engine) => engine.kill()));
      } finally {
        zedSim.close();
        hubWire.close();
        zedToHub.destroy();
        hubToZed.destroy();
      }
    }
  });

  hubWire.onRequest(async (method, params) => {
    const handler = hub.handle[method];
    if (!handler) throw Object.assign(new Error(`no ${method}`), { rpc: -32601 });
    return handler(params);
  });
  hubWire.onNotification((method, params) => hub.notify({ method, params }));

  const rpc = (method, params = {}) => zedSim.request(method, params);
  const notify = (method, params = {}) => zedSim.notify(method, params);

  return { hub, rpc, notify, updates, clientRequests, engines };
}

describe('acp hub', () => {
  let sb;
  let env;
  let ctx;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-hub-home-'));
    env = engineEnv({ ZEDPSTACK_HOME: home });
    ctx = connectHub(t, env);
  });

  it('initialize and session/new merged configOptions', async () => {
    await ctx.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: true } });
    const res = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.match(res.sessionId, /^sess-/);
    const ids = res.configOptions.map((o) => o.id);
    assert.ok(ids.includes(ZP_RUNTIME_ID));
    assert.ok(ids.includes('model'));
  });

  it('commands announced after session/new response', async () => {
    const before = ctx.updates.length;
    const res = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    await new Promise((r) => setImmediate(r));
    const cmds = ctx.updates
      .slice(before)
      .find((u) => u.update?.sessionUpdate === 'available_commands_update');
    assert.ok(cmds);
    assert.deepEqual(cmds.update.availableCommands, mergeCommands([]));
  });

  it('/claude switch emits config_option_update', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const before = ctx.updates.length;
    await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/claude' }],
    });
    const cfg = ctx.updates
      .slice(before)
      .find((u) => u.sessionId === sessionId && u.update?.sessionUpdate === 'config_option_update');
    assert.ok(cfg);
    assert.ok(cfg.update.configOptions.some((o) => o.id === ZP_RUNTIME_ID));
  });

  for (const method of ['slash command', 'set_config_option']) {
    it(`runtime switch via ${method} routes prompts and shuts down replacement`, async () => {
      const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
      const original = ctx.engines[0];
      if (method === 'slash command') {
        await ctx.rpc('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '/codex' }],
        });
      } else {
        await ctx.rpc('session/set_config_option', {
          sessionId,
          configId: ZP_RUNTIME_ID,
          value: 'codex',
        });
      }
      const replacement = ctx.engines[1];
      assert.ok(replacement);
      assert.notEqual(replacement.pid, original.pid);
      const config = ctx.updates.findLast(
        (u) => u.sessionId === sessionId && u.update?.sessionUpdate === 'config_option_update',
      );
      const before = ctx.updates.length;
      const result = await ctx.rpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello after switch' }],
      });
      const chunks = ctx.updates
        .slice(before)
        .filter((u) => u.sessionId === sessionId && u.update?.sessionUpdate === 'agent_message_chunk')
        .map((u) => u.update.content.text);
      await ctx.hub.shutdown();
      assert.deepEqual(
        {
          runtime: config.update.configOptions.find((o) => o.id === ZP_RUNTIME_ID).currentValue,
          stopReason: result.stopReason,
          chunks,
          originalAlive: processAlive(original.pid),
          replacementAlive: processAlive(replacement.pid),
        },
        {
          runtime: 'codex',
          stopReason: 'end_turn',
          chunks: ['chunk-1', 'chunk-2'],
          originalAlive: false,
          replacementAlive: false,
        },
      );
    });
  }

  it('set_config_option model forwarded and saved', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const res = await ctx.rpc('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'beta',
    });
    const model = res.configOptions.find((o) => o.id === 'model');
    assert.equal(model.currentValue, 'beta');
    const prefs = JSON.parse(fs.readFileSync(path.join(env.ZEDPSTACK_HOME, 'acp-prefs.json'), 'utf8'));
    assert.equal(prefs.perRuntime.claude.model, 'beta');
  });

  it('prompt streams child chunks with outer sessionId', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const before = ctx.updates.length;
    const res = await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(res.stopReason, 'end_turn');
    const chunks = ctx.updates
      .slice(before)
      .filter((u) => u.sessionId === sessionId && u.update?.sessionUpdate === 'agent_message_chunk');
    assert.ok(chunks.some((c) => c.update.content.text === 'chunk-1'));
  });

  it('ASK round-trips permission through hub', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const beforeReq = ctx.clientRequests.length;
    await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'ASK please' }],
    });
    const perm = ctx.clientRequests.slice(beforeReq).find((r) => r.method === 'session/request_permission');
    assert.ok(perm);
    assert.equal(perm.params.sessionId, sessionId);
  });

  it('FS passthrough', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const beforeReq = ctx.clientRequests.length;
    await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'FS read' }],
    });
    const fsReq = ctx.clientRequests.slice(beforeReq).find((r) => r.method === 'fs/read_text_file');
    assert.ok(fsReq);
    assert.equal(fsReq.params.sessionId, sessionId);
  });

  it('cancel forwards and returns cancelled', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const promptPromise = ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'SLEEP' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    ctx.notify('session/cancel', { sessionId });
    const res = await promptPromise;
    assert.equal(res.stopReason, 'cancelled');
  });

  it('rejects concurrent prompt', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const slow = ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'SLEEP' }],
    });
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(
      () => ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] }),
      (e) => e.rpc === -32602,
    );
    ctx.notify('session/cancel', { sessionId });
    await slow;
  });

  it('engine start failure still yields session', async (t) => {
    const badEnv = engineEnv({
      ZEDPSTACK_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-hub-failure-home-')),
      ZEDPSTACK_ACP_ENGINE_CLAUDE: JSON.stringify(['/no/such/binary']),
    });
    const local = connectHub(t, badEnv);
    const res = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.ok(res.configOptions.some((o) => o.id === ZP_RUNTIME_ID));
    assert.deepEqual(res.configOptions.map((o) => o.id), [ZP_RUNTIME_ID]);
    await new Promise((r) => setImmediate(r));
    assert.ok(local.updates.some((u) => u.update?.content?.text.includes('No se pudo iniciar el engine')));
  });

  it('spawn and board still work', async () => {
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const sessionId = session.sessionId;
    const board = await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/board' }],
    });
    assert.equal(board.stopReason, 'end_turn');
    const spawn = await ctx.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/spawn how explorer :: hi' }],
    });
    assert.equal(spawn.stopReason, 'end_turn');
  });
});
