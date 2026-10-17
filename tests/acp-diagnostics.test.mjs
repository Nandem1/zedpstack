import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectEngine, inspectEngines } from '../src/acp/diagnostics.mjs';
import { resolveEngine } from '../src/acp/engine.mjs';
import { runtimeOption } from '../src/acp/options.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-engine-diagnostic-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, ZEDPSTACK_HOME: home, PATH: path.join(home, 'bin') };
  fs.mkdirSync(env.PATH);
  for (const bin of ['npx', 'cursor-agent']) {
    fs.writeFileSync(path.join(env.PATH, bin), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  }
  return { home, env, registryDir: path.join(home, 'registry') };
}

describe('ACP local engine diagnosis', () => {
  it('includes ACP resolution in doctor JSON and human output without starting engines', (t) => {
    const f = fixture(t);
    const script = new URL('../scripts/dispatch.mjs', import.meta.url).pathname;
    const report = spawnSync(process.execPath, [script, 'doctor', '--json'], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(report.status, 0, report.stderr);
    const data = JSON.parse(report.stdout);
    assert.equal(data.acp.cursor.available, true);
    assert.equal(data.acp.codex.source, 'npx-pin');
    assert.equal(data.acp.codex.status, 'missing-npx-cache');
    assert.equal(data.acp.codex.version, '2.2.2');
    assert.equal(data.acp.codex.authPolicy.methods[0].id, 'chat-gpt');
    const human = spawnSync(process.execPath, [script, 'doctor', '--human'], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /ACP engines.*local check, no network/);
    assert.match(human.stdout, /codex: MISSING.*npx-pin/);
    assert.match(human.stdout, /codex login/);
    assert.match(human.stdout, /cursor: installed.*path/);
    assert.equal(fs.existsSync(path.join(f.home, '.npm')), false);
  });
  it('reports resolution precedence and versions from the same resolver as startEngine', (t) => {
    const f = fixture(t);
    const registry = { agents: [{ id: 'codex-acp', distribution: { npx: { package: '@agentclientprotocol/codex-acp@9.0.0' } } }] };
    fs.mkdirSync(f.registryDir);
    fs.writeFileSync(path.join(f.registryDir, 'registry.json'), JSON.stringify(registry));
    fs.writeFileSync(path.join(f.home, 'config'), JSON.stringify({ acp: { engines: { codex: [process.execPath, 'custom.mjs'] } } }));
    assert.equal(inspectEngine('codex', f).source, 'user-config');
    assert.equal(inspectEngine('codex', { ...f, env: { ...f.env, ZEDPSTACK_ACP_ENGINE_CODEX: '["missing-override"]' } }).source, 'env');
    const fromRegistry = inspectEngine('codex', { ...f, userConfig: {} });
    assert.equal(fromRegistry.source, 'zed-registry');
    assert.equal(fromRegistry.version, '9.0.0');
    assert.deepEqual(fromRegistry.command, ['npx', '-y', '@agentclientprotocol/codex-acp@9.0.0']);
    const pinned = inspectEngine('codex', { ...f, registry: null, userConfig: {} });
    assert.equal(pinned.source, 'npx-pin');
    assert.equal(pinned.version, '2.2.2');
    assert.throws(() => resolveEngine('unknown'), /unknown ACP runtime/);
  });

  it('checks executable and exact package cache without executing npx or making network calls', (t) => {
    const f = fixture(t);
    const options = { ...f, registry: null, userConfig: {} };
    const before = inspectEngine('codex', options);
    assert.equal(before.status, 'missing-npx-cache');
    assert.equal(before.executable, path.join(f.env.PATH, 'npx'));
    const dir = path.join(f.home, '.npm/_npx/cached/node_modules/@agentclientprotocol/codex-acp');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    const manifest = { version: '2.2.2', bin: { 'codex-acp': 'dist/index.js' } };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    assert.equal(inspectEngine('codex', options).available, false, 'an incomplete install is missing');
    fs.writeFileSync(path.join(dir, 'dist/index.js'), '');
    assert.equal(inspectEngine('codex', options).available, true);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, version: '2.2.1' }));
    assert.equal(inspectEngine('codex', options).available, false, 'another version is not the resolved engine');
    const engines = inspectEngines(options);
    assert.equal(engines.cursor.available, true);
    assert.equal(engines.cursor.source, 'path');
    assert.equal(engines.codex.authPolicy.methods[0].id, 'chat-gpt');
    const choices = runtimeOption('codex', Object.keys(engines).filter((rt) => engines[rt].available)).options;
    assert.equal(choices.find((c) => c.value === 'codex').description, '(no instalado)');
    assert.equal(choices.find((c) => c.value === 'cursor').description, undefined);
    fs.chmodSync(path.join(f.env.PATH, 'cursor-agent'), 0o644);
    assert.equal(inspectEngine('cursor', options).status, 'missing-executable');
  });
});
