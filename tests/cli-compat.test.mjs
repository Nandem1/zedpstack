import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkCliCompat,
  checkWorkerClis,
  cliVersionOf,
  describeCliCompat,
} from '../src/cliCompat.mjs';

describe('cliVersionOf', () => {
  it('reads the first version-shaped token', () => {
    assert.equal(cliVersionOf('2.1.195 (Claude Code)'), '2.1.195');
    assert.equal(cliVersionOf('v1.2.3'), '1.2.3');
    assert.equal(cliVersionOf('codex-cli 0.46.0'), null);
    assert.equal(cliVersionOf(null), null);
  });
});

describe('checkCliCompat', () => {
  it('compares claude-opus-5-5 against the registered floor', () => {
    const below = checkCliCompat({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      cliVersion: '2.1.195 (Claude Code)',
    });
    assert.equal(below?.state, 'below');
    assert.equal(below?.installed, '2.1.195');

    const ok = checkCliCompat({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      cliVersion: '2.1.280 (Claude Code)',
    });
    assert.equal(ok?.state, 'ok');

    const newer = checkCliCompat({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      cliVersion: '2.1.1000 (Claude Code)',
    });
    assert.equal(newer?.state, 'ok');
  });

  it('returns null for other models and unresolved aliases', () => {
    assert.equal(
      checkCliCompat({ runtime: 'claude', model: 'claude-sonnet-5-5', cliVersion: '2.1.195 (Claude Code)' }),
      null,
    );
    assert.equal(checkCliCompat({ runtime: 'claude', model: null, cliVersion: '2.1.195' }), null);
  });

  it('marks missing and unreadable separately', () => {
    const missing = checkCliCompat({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      cliVersion: null,
    });
    assert.equal(missing?.state, 'missing');
    assert.equal(missing?.installed, null);
  });
});

describe('checkWorkerClis', () => {
  const runtimes = {
    claude: { bin: 'claude', version: '2.1.195 (Claude Code)' },
    codex: { bin: 'codex', version: 'codex-cli 0.46.0' },
    cursor: { bin: 'agent', version: '2025.09.18' },
  };

  it('resolves opus through probeCache to the same floor', () => {
    const probeCache = { 'claude:opus': { effective: 'claude-opus-5-5' } };
    const roles = {
      'judgment and prose': {
        source: 'sheet',
        entries: [{ runtime: 'claude', model: 'opus' }],
      },
    };
    const { checks, problems } = checkWorkerClis({ roles, runtimes, probeCache });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].state, 'below');
    assert.match(problems[0], /2\.1\.280/);
  });

  it('skips opus when the probe did not resolve', () => {
    const roles = {
      'judgment and prose': {
        source: 'sheet',
        entries: [{ runtime: 'claude', model: 'opus' }],
      },
    };
    const { checks, problems } = checkWorkerClis({ roles, runtimes, probeCache: {} });
    assert.equal(checks.length, 0);
    assert.equal(problems.length, 0);
  });

  it('dedupes roles that share runtime and model', () => {
    const roles = {
      'architect runners': {
        source: 'sheet',
        entries: [{ runtime: 'claude', model: 'claude-opus-5-5' }],
      },
      'judgment and prose': {
        source: 'sheet',
        entries: [{ runtime: 'claude', model: 'claude-opus-5-5' }],
      },
    };
    const { checks } = checkWorkerClis({ roles, runtimes, probeCache: {} });
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0].roles.sort(), ['architect runners', 'judgment and prose']);
  });

  it('does not add problems for missing CLI (doctor already does)', () => {
    const roles = {
      feature: {
        source: 'sheet',
        entries: [{ runtime: 'claude', model: 'claude-opus-5-5' }],
      },
    };
    const noCli = { claude: { bin: 'claude', version: null }, codex: { bin: 'codex', version: null }, cursor: { bin: 'agent', version: null } };
    const { problems } = checkWorkerClis({ roles, runtimes: noCli, probeCache: {} });
    assert.equal(problems.length, 0);
  });
});

describe('describeCliCompat', () => {
  it('words below like cliRejection', () => {
    const line = describeCliCompat({
      state: 'below',
      runtime: 'claude',
      model: 'claude-opus-5-5',
      minimum: '2.1.280',
      evidence: 'x',
      installed: '2.1.195',
      roles: ['judgment and prose'],
    });
    assert.match(line, /claude CLI 2\.1\.195 is below 2\.1\.280/);
    assert.match(line, /"judgment and prose"/);
  });
});

describe('doctor cliCompat integration', () => {
  it('reports below minimum in JSON and human output with exit 0', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cli-compat-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fixtureBin = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures/bin');
    for (const name of fs.readdirSync(fixtureBin)) {
      const src = path.join(fixtureBin, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(binDir, name));
      if (name !== 'fake-cli.cjs') fs.chmodSync(path.join(binDir, name), 0o755);
    }
    const sheetDir = path.join(home, '.zedpstack');
    fs.mkdirSync(sheetDir, { recursive: true });
    fs.writeFileSync(
      path.join(sheetDir, 'pstack-models.md'),
      '# pstack model configuration\njudgment and prose: claude-opus-5-5\n',
    );
    const env = {
      ...process.env,
      HOME: home,
      ZEDPSTACK_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_VERSION: '2.1.195',
      PSTACK_ROOT: process.env.PSTACK_ROOT,
    };
    const script = new URL('../scripts/dispatch.mjs', import.meta.url).pathname;
    const report = spawnSync(process.execPath, [script, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(report.status, 0, report.stderr || report.stdout);
    const data = JSON.parse(report.stdout);
    const row = data.cliCompat?.find((c) => c.model === 'claude-opus-5-5');
    assert.equal(row?.state, 'below');
    assert.ok(data.problems.some((p) => p.includes('2.1.280')));
    const human = spawnSync(process.execPath, [script, 'doctor', '--human'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /below minimum: claude-opus-5-5 needs 2\.1\.280/);
  });
});
