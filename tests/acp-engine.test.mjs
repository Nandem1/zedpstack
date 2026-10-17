import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveEngineCommand, startEngine } from '../src/acp/engine.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'bin', 'fake-acp-agent.cjs');

function trackEngine(t, extraEnv = {}) {
  let child;
  t.after(async () => {
    if (!child) return;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
    for (const stream of child.stdio) stream?.destroy();
  });
  return {
    start: (opts = {}) => startEngine({
      runtime: 'cursor',
      cwd: ROOT,
      env: {
        ZEDPSTACK_ACP_ENGINE_CURSOR: JSON.stringify([process.execPath, FAKE]),
        ...extraEnv,
      },
      userConfig: {},
      spawnFn: (...args) => {
        child = spawn(...args);
        return child;
      },
      ...opts,
    }),
    get child() { return child; },
  };
}

describe('resolveEngineCommand', () => {
  it('env override wins', () => {
    const cmd = resolveEngineCommand('claude', {
      env: { ZEDPSTACK_ACP_ENGINE_CLAUDE: JSON.stringify([process.execPath, FAKE]) },
      userConfig: { acp: { engines: { claude: ['npx', 'other'] } } },
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@x/y' } } }] },
    });
    assert.deepEqual(cmd, [process.execPath, FAKE]);
  });

  it('userConfig acp.engines over registry', () => {
    const cmd = resolveEngineCommand('claude', {
      env: {},
      userConfig: { acp: { engines: { claude: ['node', 'cfg.js'] } } },
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@x/y' } } }] },
    });
    assert.deepEqual(cmd, ['node', 'cfg.js']);
  });

  it('registry npx package', () => {
    const cmd = resolveEngineCommand('claude', {
      env: {},
      userConfig: {},
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@1.0.0' } } }] },
    });
    assert.deepEqual(cmd, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@1.0.0']);
  });

  it('pinned fallback', () => {
    const cmd = resolveEngineCommand('claude', { env: {}, userConfig: {}, registry: null });
    assert.deepEqual(cmd[0], 'npx');
    assert.match(cmd[2], /claude-agent-acp@0\.93\.0/);
  });

  it('uses Cursor on PATH when registry only supplies an archive-relative command', () => {
    const cmd = resolveEngineCommand('cursor', {
      registryDir: '/zed/registry',
      registry: { agents: [{ id: 'cursor', distribution: { binary: {
        'darwin-aarch64': { cmd: './dist-package/cursor-agent', args: ['acp'] },
      } } }] },
    });
    assert.deepEqual(cmd, ['cursor-agent', 'acp']);
  });
});

describe('engine lifecycle', () => {
  for (const method of ['initialize', 'session/new']) {
    it(`failed ACP handshake at ${method} kills the child`, async (t) => {
      const tracked = trackEngine(t, { FAKE_ACP_FAIL_METHOD: method });
      await assert.rejects(tracked.start(), (error) => {
        assert.match(error.message, new RegExp(`${method} failed`));
        assert.match(error.message, /credentials rejected/);
        assert.match(error.message, /ejecuta `agent login`/);
        return true;
      });
      assert.throws(() => process.kill(tracked.child.pid, 0), { code: 'ESRCH' });
      assert.ok(tracked.child.stdio.every((stream) => stream.destroyed));
    });
  }

  for (const auth of [
    { methods: [{ id: 'browser_login' }, { id: 'cursor_login' }], expected: 'cursor_login' },
  ]) {
    it(`authenticates with ${auth.expected} before session/new`, { timeout: 3000 }, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-acp-auth-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const trace = path.join(dir, 'trace.jsonl');
      const tracked = trackEngine(t, {
        FAKE_ACP_AUTH: '1', FAKE_ACP_TRACE: trace,
        FAKE_ACP_AUTH_METHODS: JSON.stringify(auth.methods), FAKE_ACP_EXPECT_AUTH: auth.expected,
      });
      const engine = await tracked.start({ handshakeTimeoutMs: 1000 });
      const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls.map((call) => call.method), ['initialize', 'authenticate', 'session/new']);
      assert.equal(typeof calls[0].params.clientInfo.version, 'string');
      assert.deepEqual(calls[1].params, { methodId: auth.expected });
      await engine.kill();
    });
  }

  it('rejects auth methods that require interaction without leaking a child', async (t) => {
    const tracked = trackEngine(t, {
      FAKE_ACP_AUTH: '1', FAKE_ACP_AUTH_METHODS: '[{"id":"browser_login"}]',
    });
    await assert.rejects(tracked.start({ handshakeTimeoutMs: 500 }), /no usable authentication method.*browser_login.*ejecuta `agent login`/s);
    assert.throws(() => process.kill(tracked.child.pid, 0), { code: 'ESRCH' });
  });

  it('auth failure includes stderr and login instructions and kills the child', async (t) => {
    const tracked = trackEngine(t, {
      FAKE_ACP_AUTH: '1', FAKE_ACP_FAIL_METHOD: 'authenticate',
      FAKE_ACP_ERROR_DETAIL: 'Login failed or timed out. Please try again.',
    });
    await assert.rejects(tracked.start({ handshakeTimeoutMs: 500 }), (error) => {
      assert.match(error.message, /authenticate failed/);
      assert.match(error.message, /Login failed or timed out/);
      assert.match(error.message, /credentials rejected/);
      assert.match(error.message, /ejecuta `agent login`/);
      return true;
    });
    assert.throws(() => process.kill(tracked.child.pid, 0), { code: 'ESRCH' });
  });

  for (const method of ['initialize', 'authenticate', 'session/new']) {
    it(`times out a stalled ${method} and kills the child`, { timeout: 3000 }, async (t) => {
      const tracked = trackEngine(t, { FAKE_ACP_AUTH: '1', FAKE_ACP_HANG_METHOD: method });
      await assert.rejects(tracked.start({ handshakeTimeoutMs: 500 }), (error) => {
        assert.match(error.message, /timed out/);
        assert.ok(error.message.includes(method));
        assert.match(error.message, /waiting for credentials/);
        assert.match(error.message, /ejecuta `agent login`/);
        return true;
      });
      assert.throws(() => process.kill(tracked.child.pid, 0), { code: 'ESRCH' });
      assert.ok(tracked.child.stdio.every((stream) => stream.destroyed));
    });
  }

  it('preserves the exit code and stderr when the child exits during a pending request', async (t) => {
    const tracked = trackEngine(t, { FAKE_ACP_EXIT_METHOD: 'session/new' });
    await assert.rejects(tracked.start(), (error) => {
      assert.match(error.message, /exited.*23/);
      assert.match(error.message, /credentials unavailable/);
      assert.match(error.message, /session\/new/);
      return true;
    });
    assert.equal(tracked.child.exitCode, 23);
  });

  it('kill rejects pending requests and closes child pipes', async (t) => {
    const tracked = trackEngine(t);
    const engine = await tracked.start();
    const pending = engine.peer.request('session/prompt', {
      sessionId: engine.childSessionId,
      prompt: [{ type: 'text', text: 'SLEEP' }],
    });
    const rejected = assert.rejects(pending, /closed/);
    const killed = engine.kill();
    await engine.kill();
    assert.throws(() => process.kill(engine.pid, 0), { code: 'ESRCH' });
    await killed;
    await rejected;
    assert.ok(tracked.child.stdio.every((stream) => stream.destroyed));
  });

  it('kill settles after a child has already exited', { timeout: 1000 }, async (t) => {
    const tracked = trackEngine(t);
    const engine = await tracked.start();
    const exited = once(tracked.child, 'exit');
    tracked.child.kill('SIGTERM');
    await exited;
    await engine.kill();
    assert.equal(engine.dead, true);
    assert.throws(() => process.kill(engine.pid, 0), { code: 'ESRCH' });
  });
});
