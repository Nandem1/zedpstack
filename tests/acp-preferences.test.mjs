import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isOptionValueValid, loadPrefs, savePrefs } from '../src/acp/options.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';
import { childEnv } from './helpers/env.mjs';
import { loadAgent } from '../src/agents/store.mjs';
import { waitAgents } from '../src/agents/lifecycle.mjs';

const select = (id, currentValue, values) => ({
  id, name: id, type: 'select', currentValue, options: values.map((value) => ({ value, name: value })),
});
const claude = [select('model', 'alpha', ['alpha', 'beta']), select('mode', 'default', ['default', 'bypassPermissions'])];
const cursorModel = 'grok-4.6[effort=high,fast=true]';
const cursor = [
  {
    ...select('model', 'grok-4.6', []),
    options: [{ group: 'grok', name: 'Grok', options: [{ value: 'grok-4.6', name: 'Grok 4.6' }, { value: cursorModel, name: 'Grok high' }] }],
  },
  select('mode', 'agent', ['agent', 'ask']),
  { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false },
];
const valueOf = (result, id) => result.configOptions.find((option) => option.id === id)?.currentValue;

describe('ACP option values', () => {
  it('validates flat, grouped and boolean choices with exact values', () => {
    assert.equal(isOptionValueValid(claude[0], 'beta'), true);
    assert.equal(isOptionValueValid(claude[0], 'grok-4.6'), false);
    assert.equal(isOptionValueValid(cursor[0], cursorModel), true);
    assert.equal(isOptionValueValid(cursor[0], 'grok'), false);
    assert.equal(isOptionValueValid(cursor[2], true), true);
    assert.equal(isOptionValueValid(cursor[2], false), true);
    assert.equal(isOptionValueValid(cursor[2], 'true'), false);
    assert.equal(isOptionValueValid(undefined, 'anything'), false);
  });
});

describe('ACP preferences and Zed defaults', () => {
  let sb;
  let env;
  let ctx;
  let logs;
  const trace = () => fs.readFileSync(env.FAKE_ACP_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
  const prefsFile = () => path.join(env.ZEDPSTACK_HOME, 'acp-prefs.json');
  const set = (sessionId, configId, value) => ctx.rpc('session/set_config_option', { sessionId, configId, value });

  before(() => { sb = makeSandbox(); });
  beforeEach((t) => {
    const home = shortHome('zp-prefs-');
    env = engineEnv({
      ZEDPSTACK_HOME: home, FAKE_ACP_TRACE: path.join(home, 'trace.jsonl'),
      FAKE_ACP_VARIANTS: JSON.stringify({
        claude: { FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(claude) },
        cursor: { FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(cursor) },
        codex: { FAKE_ACP_LEGACY: '1' },
      }),
    });
    logs = [];
    ctx = connectHub(t, env, { log: (line) => logs.push(line) });
  });

  it('returns JSON-RPC invalid params without sending, changing state or saving invalid values', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    await set(sessionId, 'model', 'beta');
    const previous = fs.readFileSync(prefsFile(), 'utf8');
    const callsBefore = trace();
    for (const [configId, value] of [['mode', 'ask'], ['unknown', 'x'], ['model', 1], ['zp.runtime', 'bogus']]) {
      await assert.rejects(set(sessionId, configId, value), (error) => {
        assert.equal(error.rpc, -32602);
        assert.ok(error.message.includes(configId));
        assert.match(error.message, /invalid value.*Available/);
        return true;
      });
      assert.equal(fs.readFileSync(prefsFile(), 'utf8'), previous);
      assert.deepEqual(trace(), callsBefore);
    }
    const result = await set(sessionId, 'mode', 'default');
    assert.equal(valueOf(result, 'model'), 'beta');
    assert.equal(valueOf(result, 'zp.runtime'), 'claude');
    assert.equal(ctx.engines.length, 1);
  });

  for (const order of [['model', 'mode', 'zp.runtime'], ['zp.runtime', 'mode', 'model']]) {
    it(`applies zp.runtime first when Zed sends defaults in order ${order.join(', ')}`, async () => {
      const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
      const defaults = { model: cursorModel, mode: 'ask', 'zp.runtime': 'cursor' };
      await Promise.all(order.map((id) => set(sessionId, id, defaults[id])));
      const prefs = loadPrefs(env);
      assert.equal(prefs.lastRuntime, 'cursor');
      assert.deepEqual(prefs.perRuntime, { cursor: { model: cursorModel, mode: 'ask' } });
      const calls = trace().filter((call) => call.method === 'session/set_config_option');
      assert.equal(calls.length, 2);
      assert.ok(calls.every((call) => call.pid === ctx.engines[1].pid));
      assert.equal(valueOf(await set(sessionId, 'thinking', true), 'thinking'), true);
    });
  }

  it('rejects a foreign Claude mode after the runtime default has selected Cursor', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    const answers = await Promise.allSettled([
      set(sessionId, 'mode', 'bypassPermissions'), set(sessionId, 'zp.runtime', 'cursor'), set(sessionId, 'model', cursorModel),
    ]);
    assert.equal(answers[0].status, 'rejected');
    assert.equal(answers[0].reason.rpc, -32602);
    assert.equal(valueOf(answers[2].value, 'mode'), 'agent');
    assert.deepEqual(loadPrefs(env).perRuntime, { cursor: { model: cursorModel } });
    assert.ok(!trace().some((call) => call.params.value === 'bypassPermissions'));
  });

  it('keeps runtime requests FIFO ahead of pending options and survives an invalid request', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    const results = await Promise.allSettled([
      set(sessionId, 'model', 'beta'), set(sessionId, 'zp.runtime', 'cursor'),
      set(sessionId, 'unknown', 'invalid'), set(sessionId, 'zp.runtime', 'codex'), set(sessionId, 'mode', 'plan'),
    ]);
    assert.equal(results[2].status, 'rejected');
    assert.equal(results[0].status, 'fulfilled');
    assert.deepEqual(ctx.engines.map((engine) => engine.runtime), ['claude', 'cursor', 'codex']);
    assert.deepEqual(loadPrefs(env).perRuntime, { codex: { model: 'beta', mode: 'plan' } });
    const sends = trace().filter((call) => /session\/set_(model|mode)$/.test(call.method));
    assert.deepEqual(sends.map((call) => call.pid), [ctx.engines[2].pid, ctx.engines[2].pid]);
  });

  it('restores each runtime independently, including grouped native and legacy choices', async () => {
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    await set(sessionId, 'mode', 'bypassPermissions');
    await set(sessionId, 'model', 'beta');
    await set(sessionId, 'zp.runtime', 'cursor');
    await set(sessionId, 'model', cursorModel);
    await set(sessionId, 'mode', 'ask');
    await set(sessionId, 'zp.runtime', 'codex');
    await set(sessionId, 'model', 'beta');
    await set(sessionId, 'mode', 'plan');
    for (const [runtime, model, mode] of [['claude', 'beta', 'bypassPermissions'], ['cursor', cursorModel, 'ask'], ['codex', 'beta', 'plan']]) {
      const result = await set(sessionId, 'zp.runtime', runtime);
      assert.equal(valueOf(result, 'model'), model);
      assert.equal(valueOf(result, 'mode'), mode);
    }
    assert.deepEqual(loadPrefs(env).perRuntime, {
      claude: { mode: 'bypassPermissions', model: 'beta' }, cursor: { model: cursorModel, mode: 'ask' }, codex: { model: 'beta', mode: 'plan' },
    });
  });

  for (const runtime of ['claude', 'codex']) {
    it(`drops stale ${runtime} values before reapplying, saves only valid values and logs each removal once`, async () => {
      savePrefs({ lastRuntime: runtime, perRuntime: {
        [runtime]: { model: 'beta', mode: 'removed', old: 'removed', 'zp.runtime': 'cursor' },
        cursor: { model: cursorModel, mode: 'ask' },
      } }, env);
      const result = await ctx.rpc('session/new', { cwd: sb.repo });
      assert.equal(valueOf(result, 'model'), 'beta');
      assert.deepEqual(loadPrefs(env).perRuntime, { [runtime]: { model: 'beta' }, cursor: { model: cursorModel, mode: 'ask' } });
      assert.equal(logs.filter((line) => line.includes('dropped stale preference')).length, 3);
      assert.ok(!trace().some((call) => Object.values(call.params).includes('removed')));
      await set(result.sessionId, 'zp.runtime', runtime);
      assert.equal(logs.filter((line) => line.includes('dropped stale preference')).length, 3);
    });
  }

  it('keeps a valid preference when reapplication fails transiently', async () => {
    env.FAKE_ACP_FAIL_CONFIG_ID = 'model';
    savePrefs({ lastRuntime: 'claude', perRuntime: { claude: { model: 'beta' } } }, env);
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    assert.deepEqual(loadPrefs(env).perRuntime, { claude: { model: 'beta' } });
    assert.ok(logs.some((line) => /could not reapply model.*temporary config failure/.test(line)));
    const previous = fs.readFileSync(prefsFile(), 'utf8');
    await assert.rejects(set(sessionId, 'model', 'beta'), /temporary config failure/);
    assert.equal(fs.readFileSync(prefsFile(), 'utf8'), previous);
  });

  it('validates the next preference against choices returned after the saved model is selected', async () => {
    env.FAKE_ACP_CONFIG_BY_MODEL = JSON.stringify({ beta: [claude[0], select('mode', 'default', ['default'])] });
    savePrefs({ lastRuntime: 'claude', perRuntime: { claude: { model: 'beta', mode: 'bypassPermissions' } } }, env);
    const result = await ctx.rpc('session/new', { cwd: sb.repo });
    assert.equal(valueOf(result, 'model'), 'beta');
    assert.equal(valueOf(result, 'mode'), 'default');
    assert.deepEqual(loadPrefs(env).perRuntime, { claude: { model: 'beta' } });
    assert.ok(!trace().some((call) => call.method === 'session/set_config_option' && call.params.configId === 'mode'));
    assert.equal(logs.filter((line) => line.includes('dropped stale preference')).length, 1);
  });

  it('handles malformed preference records without selecting an unknown runtime', async () => {
    for (const contents of ['null', '{"lastRuntime":"bogus","perRuntime":[]}', '{"lastRuntime":"cursor","perRuntime":{"cursor":null}}']) {
      fs.writeFileSync(prefsFile(), contents);
      const prefs = loadPrefs(env);
      assert.deepEqual(prefs.perRuntime, {});
      assert.ok(['claude', 'cursor'].includes(prefs.lastRuntime));
    }
  });

  it('removes malformed saved option values instead of retaining object references', async () => {
    savePrefs({ lastRuntime: 'claude', perRuntime: { claude: { mode: { value: 'bypassPermissions' }, model: ['beta'] } } }, env);
    await ctx.rpc('session/new', { cwd: sb.repo });
    assert.deepEqual(loadPrefs(env).perRuntime, { claude: {} });
    assert.equal(logs.filter((line) => line.includes('dropped stale preference')).length, 2);
  });

  it('accepts native configOptions captured from codex-acp 2.2.2 without legacy model parameters', async () => {
    const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/acp/codex-2.2.2.json', import.meta.url), 'utf8'));
    env.FAKE_ACP_VARIANTS = JSON.stringify({ codex: { FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(snapshot.configOptions) } });
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    const defaults = {
      model: 'gpt-6-astra', reasoning_effort: 'high', mode: 'workspace-write', collaboration_mode: 'plan', 'fast-mode': 'on',
    };
    const responses = await Promise.all([
      ...Object.entries(defaults).map(([id, value]) => set(sessionId, id, value)), set(sessionId, 'zp.runtime', 'codex'),
    ]);
    for (const [id, value] of Object.entries(defaults)) assert.equal(valueOf(responses.at(-2), id), value);
    assert.deepEqual(loadPrefs(env).perRuntime, { codex: defaults });
    await assert.rejects(set(sessionId, 'model', 'gpt-6-astra[high]'), (error) => error.rpc === -32602);
    assert.ok(trace().filter((call) => call.method.startsWith('session/set_')).every((call) => call.method === 'session/set_config_option'));
  });
});

describe('MCP uses the hub worker sheet without inherited engine environment', () => {
  it('spawns from the explicit temporary sheet through the injected MCP', { timeout: 15000 }, async (t) => {
    const sb = makeSandbox({ sheet: 'how explorer: gpt-6.1-sol\n' });
    const env = childEnv(engineEnv({
      ZEDPSTACK_HOME: shortHome('zp-env-mcp-'), FAKE_ACP_MCP: '1', FAKE_ACP_MCP_ENV_ONLY: '1',
    }));
    const ctx = connectHub(t, env);
    const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
    await ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SPAWN read-only worker' }] });
    const agentId = ctx.updates.findLast((u) => u.update.content?.text?.startsWith('spawned:')).update.content.text.slice('spawned:'.length);
    const view = loadAgent(sb.repo, agentId);
    assert.equal(view.spec.binding.runtime, 'codex');
    assert.equal(view.spec.binding.model, 'gpt-6.1-sol');
    assert.equal(view.spec.origin.sessionId, sessionId);
    const waited = await waitAgents({ repo: sb.repo, ids: [agentId], timeoutSeconds: 10, pollMs: 50 });
    assert.equal(waited.done[0].status, 'completed');
  });
});
