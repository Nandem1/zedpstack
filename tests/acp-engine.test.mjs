import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
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
    start: () => startEngine({
      runtime: 'claude',
      cwd: ROOT,
      env: {
        ZEDPSTACK_ACP_ENGINE_CLAUDE: JSON.stringify([process.execPath, FAKE]),
        ...extraEnv,
      },
      userConfig: {},
      spawnFn: (...args) => {
        child = spawn(...args);
        return child;
      },
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
});

describe('engine lifecycle', () => {
  for (const method of ['initialize', 'session/new']) {
    it(`failed ACP handshake at ${method} kills the child`, async (t) => {
      const tracked = trackEngine(t, { FAKE_ACP_FAIL_METHOD: method });
      await assert.rejects(tracked.start(), { message: `${method} failed` });
      assert.throws(() => process.kill(tracked.child.pid, 0), { code: 'ESRCH' });
      assert.ok(tracked.child.stdio.every((stream) => stream.destroyed));
    });
  }

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
