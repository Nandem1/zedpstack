import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './helpers/sandbox.mjs';
import { applyModelSheetToConfig } from '../src/setupConfig.mjs';
import { runPlaybook } from '../src/run.mjs';
import { readManifest, writeManifestAtomic } from '../src/manifest.mjs';
import { validationProfileForRole } from '../src/roles.mjs';

describe('architect batch execution', () => {
  let sandbox;
  let originalEnv;
  let configPath;

  function applyPanel(models) {
    fs.writeFileSync(sandbox.sheetPath,
      `how explorer: haiku\nhow explainer: sonnet\narchitect runners: ${models.join(', ')}\ndefault effort: session\n`);
    return applyModelSheetToConfig({ sheetPath: sandbox.sheetPath, configPath });
  }

  const pair = ['gpt-6.1-sol', 'opus'];
  const triple = [...pair, 'cursor:grok-4.7-high'];
  const run = (runId) => runPlaybook({
    playbookId: 'architect-sketch', goal: 'Design src/index.mjs', repoRoot: sandbox.repo, runId,
  });
  const synthesisPrompt = (runRoot) => fs.readFileSync(path.join(runRoot, 'workers/synthesize/prompt.md'), 'utf8');

  beforeEach(() => {
    originalEnv = { ...process.env };
    sandbox = makeSandbox();
    configPath = path.join(sandbox.root, 'config.json');
    process.env.ZEDPSTACK_CONFIG = configPath;
    process.env.PSTACK_ROOT = path.join(sandbox.root, 'pstack');
    const refs = {
      'how/references/explorer-prompt.md': 'Read src/index.mjs to answer {QUESTION}.\n{EXPLORATION_ANGLE}',
      'architect/references/runner-prompt.md': 'Produce a design for the supplied task.',
      'architect/references/rationale-template.md': '## Usage\n## Shape',
      'architect/references/design-red-flags.md': 'Check for duplicated state.',
    };
    for (const [relative, text] of Object.entries(refs)) {
      const file = path.join(process.env.PSTACK_ROOT, 'skills', relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('CLI runs GPT, Opus and Grok and passes all three results to synthesis', () => {
    assert.deepEqual(applyPanel(triple).overflows, []);
    const cli = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/dispatch.mjs', import.meta.url)),
      'run', '--playbook', 'architect-sketch', '--goal', 'Design src/index.mjs',
      '--repo', sandbox.repo, '--run-id', 'three',
    ], { env: process.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(cli.status, 0, cli.stderr);
    const { runRoot, status } = JSON.parse(cli.stdout);
    assert.equal(status, 'awaiting_judgment');
    const manifest = readManifest(runRoot);
    assert.equal(manifest.status, 'awaiting_judgment');
    assert.ok(manifest.steps.every((step) => step.status === 'completed'));
    assert.equal(manifest.steps.length, 5);
    const c = manifest.steps.find((step) => step.stepId === 'sketch-c');
    assert.equal(c.binding.runtime, 'cursor');
    assert.equal(c.binding.model, 'grok-4.7-high');
    assert.equal(validationProfileForRole(c.role), 'explorer');
    const prompt = synthesisPrompt(runRoot);
    for (const model of ['gpt-6.1-sol', 'opus', 'grok-4.7-high']) {
      assert.ok(prompt.includes(`model=${model}`), `${model} result reaches synthesis`);
    }
    const events = fs.readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const waves = events.filter((event) => event.type === 'step.wave.started');
    assert.deepEqual(waves.map((event) => event.stepIds), [
      ['ground'], ['sketch-a', 'sketch-b', 'sketch-c'], ['synthesize'],
    ]);
  });

  it('resumes a two-runner manifest with two candidates after c is configured', async () => {
    applyPanel(pair);
    const first = await run('legacy-two');
    assert.equal(first.manifest.status, 'awaiting_judgment');
    assert.deepEqual(first.manifest.steps.map((step) => step.stepId), ['ground', 'sketch-a', 'sketch-b', 'synthesize']);
    first.manifest.status = 'failed';
    first.manifest.steps.find((step) => step.stepId === 'synthesize').status = 'failed';
    writeManifestAtomic(first.runRoot, first.manifest);
    applyPanel(triple);

    const resumed = await run('legacy-two');
    assert.equal(resumed.manifest.status, 'awaiting_judgment');
    assert.equal(resumed.manifest.steps.length, 4);
    assert.doesNotMatch(synthesisPrompt(resumed.runRoot), /Candidate sketch-c/);
    assert.ok(!sandbox.cliCalls().some((call) => call.runtime === 'cursor'));
  });

  it('resumes a pending third runner after its explicit binding is removed', async () => {
    applyPanel(triple);
    const first = await run('keep-three');
    assert.equal(first.manifest.status, 'awaiting_judgment');
    first.manifest.status = 'failed';
    for (const step of first.manifest.steps) {
      if (['sketch-c', 'synthesize'].includes(step.stepId)) step.status = 'pending';
    }
    writeManifestAtomic(first.runRoot, first.manifest);
    applyPanel(pair);
    const callsBefore = sandbox.cliCalls().length;

    const resumed = await run('keep-three');
    assert.equal(resumed.manifest.status, 'awaiting_judgment');
    assert.ok(resumed.manifest.steps.every((step) => step.status === 'completed'));
    assert.equal(sandbox.cliCalls().length - callsBefore, 2, 'pending c runs before synthesis');
    assert.match(synthesisPrompt(resumed.runRoot), /Candidate sketch-c\n\nfake claude report\nmodel=haiku/);
  });

  it('rejects an explicit malformed c binding before starting workers', async () => {
    applyPanel(pair);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.roles['architect-runner-c'] = {};
    fs.writeFileSync(configPath, JSON.stringify(config));

    await assert.rejects(run('invalid-c'), /Missing RoleBinding for role "architect-runner-c"/);
    assert.deepEqual(sandbox.cliCalls(), []);
  });
});
