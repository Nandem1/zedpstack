import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlaybook } from '../src/run.mjs';
import { readManifest } from '../src/manifest.mjs';

describe('runPlaybook when a worker cannot start', () => {
  it('marks the step failed instead of leaving it running, and resume never reaches judgment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-runfail-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const config = path.join(dir, 'config.json');
    const binding = { runtime: 'codex', model: 'gpt-6.1-sol', permissionProfile: 'read-only' };
    fs.writeFileSync(config, JSON.stringify({ roles: { 'how-explorer': binding, 'how-explainer': binding, explorer: binding, synthesizer: binding } }));
    process.env.ZEDPSTACK_CONFIG = config;
    process.env.PATH = path.join(dir, 'empty-bin');

    const first = await runPlaybook({ playbookId: 'how-investigation', goal: 'How?', repoRoot: repo, runId: 'r1' });
    assert.equal(first.manifest.status, 'failed');
    const runRoot = path.join(repo, '.zedpstack', 'runs', 'r1');
    let manifest = readManifest(runRoot);
    assert.ok(manifest.steps.every((s) => s.status !== 'running'));
    const failed = manifest.steps.find((s) => s.status === 'failed');
    assert.match(failed.lastErrors[0], /CLI "codex" not available/);

    const resumed = await runPlaybook({ playbookId: 'how-investigation', goal: 'How?', repoRoot: repo, runId: 'r1' });
    assert.equal(resumed.manifest.status, 'failed');
    manifest = readManifest(runRoot);
    assert.ok(manifest.steps.every((s) => s.status !== 'running'));
  });
});
