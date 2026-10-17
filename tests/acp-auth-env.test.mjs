import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectAuthMethod } from '../src/acp/auth.mjs';
import { engineMcpEnv, startEngine } from '../src/acp/engine.mjs';
import { FAKE_AGENT } from './helpers/acpHub.mjs';

const codexMethods = [
  { id: 'api-key', name: 'API Key', description: 'Use an API key to authenticate', _meta: { 'api-key': { provider: 'openai' } } },
  { id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate' },
  { id: 'chat-gpt-device-code', name: 'ChatGPT (device code)' },
];

describe('ACP authentication policy', () => {
  it('reuses Codex login regardless of method order, names, metadata or a supplied key', () => {
    for (const methods of [codexMethods, [...codexMethods].reverse()]) {
      for (const env of [{}, { OPENAI_API_KEY: 'present' }]) {
        assert.equal(selectAuthMethod('codex', methods, env).id, 'chat-gpt');
      }
    }
  });

  it('selects an API key method only when its key exists in the hub environment', () => {
    for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY']) {
      assert.equal(selectAuthMethod('codex', [codexMethods[0]], { [key]: 'present' }).id, 'api-key');
    }
    for (const env of [{}, { CODEX_API_KEY: '' }, { OPENAI_API_KEY: '   ' }, { ANTHROPIC_API_KEY: 'unrelated' }]) {
      assert.throws(() => selectAuthMethod('codex', [codexMethods[0]], env), /Disponibles: api-key.*codex login.*CODEX_API_KEY.*OPENAI_API_KEY/);
    }
  });

  it('rejects unknown and interactive methods with the available choices and runtime hint', () => {
    assert.equal(selectAuthMethod('cursor', [{ id: 'cursor_login' }]).id, 'cursor_login');
    assert.equal(selectAuthMethod('claude', [{ id: 'claude-login' }]).id, 'claude-login');
    assert.throws(() => selectAuthMethod('codex', [{ id: 'browser-login' }]), /browser-login.*codex login/);
    assert.throws(() => selectAuthMethod('cursor', [{ id: 'api-key' }], { OPENAI_API_KEY: 'present' }), /api-key.*agent login/);
  });

  for (const scenario of [
    { methods: codexMethods, env: {}, expected: 'chat-gpt' },
    { methods: [codexMethods[0]], env: { CODEX_API_KEY: 'present' }, expected: 'api-key' },
    { methods: [codexMethods[0]], env: {}, expected: null },
  ]) {
    it(`Codex handshake ${scenario.expected ?? 'rejects missing credentials'} before opening a session`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-auth-policy-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const trace = path.join(dir, 'trace.jsonl');
      const opening = startEngine({
        runtime: 'codex', cwd: dir, userConfig: {},
        env: {
          ZEDPSTACK_ACP_ENGINE_CODEX: JSON.stringify([process.execPath, FAKE_AGENT]),
          FAKE_ACP_AUTH: '1', FAKE_ACP_AUTH_METHODS: JSON.stringify(scenario.methods),
          FAKE_ACP_TRACE: trace, ...scenario.env,
        },
      });
      if (scenario.expected) {
        const engine = await opening;
        t.after(() => engine.kill());
        const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(calls.map((c) => c.method), ['initialize', 'authenticate', 'session/new']);
        assert.equal(calls[1].params.methodId, scenario.expected);
      } else {
        await assert.rejects(opening, /authenticate failed.*api-key.*codex login/s);
        assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).map((c) => c.method), ['initialize']);
      }
    });
  }
});

describe('injected MCP environment', () => {
  it('forwards only the allowed prefixes, PATH and HOME, and replaces outer-session values', () => {
    const env = {
      HOME: '/hub/home', PATH: '/hub/bin', ZEDPSTACK_HOME: '/hub/zp', ZEDPSTACK_MODEL_SHEET: '/hub/sheet',
      PSTACK_ROOT: '/hub/pstack', PSTACK_CUSTOM: 'custom', ZEDPSTACK_CUSTOM: 'custom',
      ZEDPSTACK_ACP_SESSION: 'parent', ZEDPSTACK_ACP_BRIDGE: '/parent.sock', ZEDPSTACK_PARENT_PID: '1', ZEDPSTACK_REPO: '/parent',
      OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CURSOR_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret', TMPDIR: '/unrelated', SHELL: '/unrelated',
    };
    const snapshot = { ...env };
    const values = Object.fromEntries(engineMcpEnv({ env, sessionId: 'outer', repo: '/repo', bridgePath: '/hub.sock', parentPid: 42 })
      .map(({ name, value }) => [name, value]));
    assert.deepEqual(values, {
      HOME: '/hub/home', PATH: '/hub/bin', ZEDPSTACK_HOME: '/hub/zp', ZEDPSTACK_MODEL_SHEET: '/hub/sheet',
      PSTACK_ROOT: '/hub/pstack', PSTACK_CUSTOM: 'custom', ZEDPSTACK_CUSTOM: 'custom',
      ZEDPSTACK_ACP_SESSION: 'outer', ZEDPSTACK_ACP_BRIDGE: '/hub.sock', ZEDPSTACK_PARENT_PID: '42', ZEDPSTACK_REPO: '/repo',
    });
    assert.deepEqual(env, snapshot);
    assert.ok(!engineMcpEnv({ env, sessionId: 'outer', repo: '/repo', parentPid: 42 }).some(({ name }) => name === 'ZEDPSTACK_ACP_BRIDGE'));
  });
});
