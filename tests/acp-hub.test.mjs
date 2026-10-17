import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZP_RUNTIME_ID } from '../src/acp/options.mjs';
import { orchestratorPrompt } from '../src/orchestratorPrompt.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const HUB_COMMAND_NAMES = ['claude', 'codex', 'cursor', 'board', 'edits'];
const CHILD_COMMAND_NAMES = ['help', 'compact'];

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('acp hub', () => {
  let sb;
  let env;
  let ctx;

  before(() => {
    sb = makeSandbox();
  });

  beforeEach((t) => {
    const home = shortHome('zp-hub-home-');
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

  it('warns once in the thread when the engine reports another model than the one selected', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const warnings = () => ctx.updates.filter(
      (u) => u.update?.sessionUpdate === 'agent_message_chunk' && /model mismatch/.test(u.update.content?.text ?? ''),
    );
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'USAGE=alpha-20260101' }] });
    assert.equal(warnings().length, 0, 'the selected model ran');
    assert.ok(ctx.updates.some((u) => u.update?.sessionUpdate === 'usage_update'), 'usage updates still reach Zed');

    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'USAGE=claude-opus-4-8' }] });
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'USAGE=claude-opus-4-8' }] });
    assert.equal(warnings().length, 1, 'one warning per requested/effective pair');
    assert.match(warnings()[0].update.content.text, /requested alpha, the CLI ran claude-opus-4-8, expected alpha/);
  });

  for (const timing of ['session/new', 'prompt']) {
    it(`merged commands survive child updates on ${timing}, runtime switch, and restart`, async () => {
      env.FAKE_ACP_COMMANDS_TIMING = timing;
      const commandUpdates = () => ctx.updates.filter(
        (u) => u.update?.sessionUpdate === 'available_commands_update',
      );
      const lastCommands = () => commandUpdates().at(-1)?.update.availableCommands.map((c) => c.name);
      const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
      assert.deepEqual(commandUpdates(), [], 'commands must follow the session/new response');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(lastCommands(), [
        ...HUB_COMMAND_NAMES,
        ...(timing === 'session/new' ? CHILD_COMMAND_NAMES : []),
      ]);
      await ctx.rpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
      assert.deepEqual(lastCommands(), [...HUB_COMMAND_NAMES, ...CHILD_COMMAND_NAMES]);

      for (const childName of ['review', 'restart']) {
        env.FAKE_ACP_COMMANDS = JSON.stringify([{ name: childName, description: childName }]);
        const before = commandUpdates().length;
        await ctx.rpc('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '/codex' }],
        });
        assert.ok(commandUpdates().length > before, 'replacement engine reannounces commands');
        assert.deepEqual(lastCommands(), [
          ...HUB_COMMAND_NAMES,
          ...(timing === 'session/new' ? [childName] : []),
        ]);
        await ctx.rpc('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'hello after switch' }],
        });
        assert.deepEqual(lastCommands(), [...HUB_COMMAND_NAMES, childName]);
      }
      for (const update of commandUpdates()) {
        assert.equal(update.sessionId, sessionId);
        assert.deepEqual(
          update.update.availableCommands.slice(0, HUB_COMMAND_NAMES.length).map((c) => c.name),
          HUB_COMMAND_NAMES,
        );
      }
    });
  }

  it('child commands received while applying saved prefs wait for session/new response', async () => {
    env.FAKE_ACP_COMMANDS_TIMING = 'prompt';
    fs.writeFileSync(path.join(env.ZEDPSTACK_HOME, 'acp-prefs.json'), JSON.stringify({
      lastRuntime: 'claude',
      perRuntime: { claude: { model: 'beta' } },
    }));
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.ok(!ctx.updates.some((u) => u.update?.sessionUpdate === 'available_commands_update'));
    await new Promise((resolve) => setImmediate(resolve));
    const commands = ctx.updates.filter((u) => u.update?.sessionUpdate === 'available_commands_update');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, sessionId);
    assert.deepEqual(commands[0].update.availableCommands.map((c) => c.name), [
      ...HUB_COMMAND_NAMES, ...CHILD_COMMAND_NAMES,
    ]);
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

  it('derives legacy options, routes changes and updates, and replays runtime preferences', async () => {
    env.FAKE_ACP_LEGACY = '1';
    env.FAKE_ACP_TRACE = path.join(env.ZEDPSTACK_HOME, 'calls.jsonl');
    const readCalls = () => fs.readFileSync(env.FAKE_ACP_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
    const session = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.deepEqual(session.configOptions.map((option) => option.id), [ZP_RUNTIME_ID, 'model', 'mode']);
    assert.deepEqual(session.models, {
      currentModelId: 'alpha',
      availableModels: [{ modelId: 'alpha', name: 'Alpha' }, { modelId: 'beta', name: 'Beta' }],
    });
    assert.deepEqual(session.modes, {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent', description: 'Make changes' },
        { id: 'plan', name: 'Plan', description: 'Plan changes' },
      ],
    });
    const { sessionId } = session;
    for (const [configId, value, method, valueKey] of [
      ['model', 'beta', 'session/set_model', 'modelId'],
      ['mode', 'plan', 'session/set_mode', 'modeId'],
    ]) {
      const result = await ctx.rpc('session/set_config_option', { sessionId, configId, value });
      assert.equal(result.configOptions.find((option) => option.id === configId).currentValue, value);
      assert.deepEqual(result.configOptions.map((option) => option.id), [ZP_RUNTIME_ID, 'model', 'mode']);
      const call = readCalls().findLast((call) => call.method === method);
      assert.deepEqual(call.params, { sessionId: ctx.engines[0].childSessionId, [valueKey]: value });
      assert.ok(!readCalls().some((call) => call.method === 'session/set_config_option'));
      const update = ctx.updates.findLast((entry) => entry.update.sessionUpdate === 'config_option_update');
      assert.equal(update.sessionId, sessionId);
      assert.equal(update.update.configOptions.find((option) => option.id === configId).currentValue, value);
      assert.deepEqual(update.update.configOptions.map((option) => option.id), [ZP_RUNTIME_ID, 'model', 'mode']);
    }
    const prefs = JSON.parse(fs.readFileSync(path.join(env.ZEDPSTACK_HOME, 'acp-prefs.json'), 'utf8'));
    assert.deepEqual(prefs.perRuntime.claude, { model: 'beta', mode: 'plan' });
    await ctx.rpc('session/set_config_option', { sessionId, configId: ZP_RUNTIME_ID, value: 'cursor' });
    const restored = await ctx.rpc('session/set_config_option', { sessionId, configId: ZP_RUNTIME_ID, value: 'claude' });
    assert.equal(restored.configOptions.find((option) => option.id === 'model').currentValue, 'beta');
    assert.equal(restored.configOptions.find((option) => option.id === 'mode').currentValue, 'plan');
    const replay = readCalls().filter((call) => call.pid === ctx.engines[2].pid);
    assert.deepEqual(replay.slice(2).map((call) => call.method), ['session/set_model', 'session/set_mode']);
    assert.deepEqual(replay[2].params, { sessionId: ctx.engines[2].childSessionId, modelId: 'beta' });
    assert.deepEqual(replay[3].params, { sessionId: ctx.engines[2].childSessionId, modeId: 'plan' });
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
      ZEDPSTACK_HOME: shortHome('zp-hub-failure-home-'),
      ZEDPSTACK_ACP_ENGINE_CLAUDE: JSON.stringify(['/no/such/binary']),
    });
    const local = connectHub(t, badEnv);
    const res = await local.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    assert.ok(res.configOptions.some((o) => o.id === ZP_RUNTIME_ID));
    assert.deepEqual(res.configOptions.map((o) => o.id), [ZP_RUNTIME_ID]);
    await new Promise((r) => setImmediate(r));
    assert.ok(local.updates.some((u) => u.update?.content?.text.includes('No se pudo iniciar el engine')));
  });

  it('/board answers locally and /spawn is no longer a hub command', async () => {
    env.FAKE_ACP_TRACE = path.join(env.ZEDPSTACK_HOME, 'calls.jsonl');
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    const board = await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/board' }] });
    assert.equal(board.stopReason, 'end_turn');
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/spawn how explorer :: hi' }] });
    const forwarded = fs.readFileSync(env.FAKE_ACP_TRACE, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((call) => call.method === 'session/prompt')
      .map((call) => call.params.prompt.at(-1).text);
    assert.deepEqual(forwarded, ['/spawn how explorer :: hi']);
  });

  it('prefixes the orchestrator skill once per engine session, skipping /board and child commands', async () => {
    env.FAKE_ACP_TRACE = path.join(env.ZEDPSTACK_HOME, 'calls.jsonl');
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo, mcpServers: [] });
    for (const text of ['/board', '/help', 'first', 'second', '/codex', 'after switch', 'again']) {
      await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    }
    const skill = orchestratorPrompt();
    const prompts = fs.readFileSync(env.FAKE_ACP_TRACE, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((call) => call.method === 'session/prompt')
      .map((call) => ({
        user: call.params.prompt.at(-1).text,
        primed: call.params.prompt.length === 2 && call.params.prompt[0].text === skill,
        blocks: call.params.prompt.length,
      }));
    assert.deepEqual(prompts, [
      { user: '/help', primed: false, blocks: 1 },
      { user: 'first', primed: true, blocks: 2 },
      { user: 'second', primed: false, blocks: 1 },
      { user: 'after switch', primed: true, blocks: 2 },
      { user: 'again', primed: false, blocks: 1 },
    ]);
    assert.match(skill, /## Task\n/);
  });
});
