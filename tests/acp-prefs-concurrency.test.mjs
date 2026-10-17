import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPrefs, savePrefs, updatePrefs } from '../src/acp/options.mjs';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { startHubProcess } from './helpers/acpProcess.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for configuration');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const select = (id) => ({ id, name: id, type: 'select', currentValue: 'a', options: ['a', 'b'].map((value) => ({ value, name: value })) });

describe('ACP preference transactions', () => {
  it('merges interleaved replies from sessions with different runtimes', { timeout: 10000 }, async (t) => {
    const sb = makeSandbox();
    const home = shortHome('zp-prefs-race-');
    const gate = path.join(home, 'release');
    const trace = path.join(home, 'trace.jsonl');
    const env = childEnv(engineEnv({
      ZEDPSTACK_HOME: home, FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([select('model'), select('effort')]),
      FAKE_ACP_TRACE: trace,
      FAKE_ACP_VARIANTS: JSON.stringify({ claude: { FAKE_ACP_CONFIG_GATE: gate } }),
    }));
    const ctx = connectHub(t, env);
    t.after(() => fs.writeFileSync(gate, ''));
    const a = await ctx.rpc('session/new', { cwd: sb.repo });
    const b = await ctx.rpc('session/new', { cwd: sb.repo });
    await ctx.rpc('session/set_config_option', { sessionId: b.sessionId, configId: 'zp.runtime', value: 'cursor' });
    const pending = ctx.rpc('session/set_config_option', { sessionId: a.sessionId, configId: 'model', value: 'b' });
    await waitFor(() => fs.readFileSync(trace, 'utf8').includes('"configId":"model"'));
    await ctx.rpc('session/set_config_option', { sessionId: b.sessionId, configId: 'effort', value: 'b' });
    assert.deepEqual(loadPrefs(env).perRuntime, { cursor: { effort: 'b' } });
    fs.writeFileSync(gate, '');
    await pending;
    assert.deepEqual(loadPrefs(env).perRuntime, { cursor: { effort: 'b' }, claude: { model: 'b' } });
  });

  it('two hub processes preserve every key while sharing one preferences file', { timeout: 15000 }, async (t) => {
    const sb = makeSandbox();
    const home = shortHome('zp-two-hubs-');
    const env = childEnv(engineEnv({ ZEDPSTACK_HOME: home, FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(Array.from({ length: 30 }, (_, i) => select(`key${i}`))) }));
    const hubs = [startHubProcess(t, env), startHubProcess(t, env)];
    const sessions = await Promise.all(hubs.map((hub) => hub.peer.request('session/new', { cwd: sb.repo })));
    await hubs[1].peer.request('session/set_config_option', { sessionId: sessions[1].sessionId, configId: 'zp.runtime', value: 'cursor' });
    await Promise.all(hubs.map(async (hub, index) => {
      for (let i = 0; i < 30; i += 1) {
        await hub.peer.request('session/set_config_option', { sessionId: sessions[index].sessionId, configId: `key${i}`, value: 'b' });
      }
    }));
    const expected = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'b']));
    assert.deepEqual(loadPrefs(env), { lastRuntime: 'cursor', perRuntime: { claude: expected, cursor: expected } });
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith('acp-prefs')), ['acp-prefs.json']);
    assert.ok(hubs.every((hub) => hub.child.exitCode === null));
  });

  it('recovers a dead owner and serializes writers without exposing partial JSON', { timeout: 10000 }, async (t) => {
    const home = shortHome('zp-prefs-lock-');
    const env = { ZEDPSTACK_HOME: home };
    savePrefs({ lastRuntime: 'claude', perRuntime: {} }, env);
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('close', resolve));
    const lock = path.join(home, 'acp-prefs.json.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, `${dead.pid}-abcdef`), '');
    const moduleUrl = new URL('../src/acp/options.mjs', import.meta.url).href;
    const script = `import fs from 'node:fs'; import { updatePrefs } from ${JSON.stringify(moduleUrl)};
      await updatePrefs(p => { fs.writeFileSync(process.env.READY, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); p.perRuntime.claude = { model: 'b' }; });`;
    const ready = path.join(home, 'ready');
    const writer = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv({ ...env, READY: ready }), stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => writer.kill('SIGKILL'));
    let errors = '';
    writer.stderr.on('data', (chunk) => { errors += chunk; });
    const exited = new Promise((resolve) => writer.once('close', resolve));
    await waitFor(() => fs.existsSync(ready));
    const merge = updatePrefs((prefs) => { prefs.perRuntime.cursor = { mode: 'ask' }; }, env);
    const snapshots = [];
    const reader = setInterval(() => snapshots.push(JSON.parse(fs.readFileSync(path.join(home, 'acp-prefs.json'), 'utf8'))), 2);
    try {
      await merge;
      assert.equal(await exited, 0, errors);
    } finally { clearInterval(reader); }
    assert.deepEqual(loadPrefs(env).perRuntime, { claude: { model: 'b' }, cursor: { mode: 'ask' } });
    assert.ok(snapshots.length > 0);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith('acp-prefs')), ['acp-prefs.json']);
  });
});
