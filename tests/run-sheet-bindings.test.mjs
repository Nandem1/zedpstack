import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPlaybook } from '../src/run.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

describe('runPlaybook sheet-first role bindings', () => {
  let sandbox;
  let originalEnv;
  let configPath;

  beforeEach(() => {
    originalEnv = { ...process.env };
    sandbox = makeSandbox({
      sheet: 'how explorer: gpt-6.1-sol\nhow explainer: opus\ndefault effort: session\n',
    });
    process.env.PSTACK_ROOT = path.join(sandbox.root, 'pstack');
    for (const [relative, text] of Object.entries({
      'how/references/explorer-prompt.md': 'Read src/index.mjs to answer {QUESTION}.\n{EXPLORATION_ANGLE}',
      'how/references/explainer-prompt.md': 'Summarize the exploration.\n',
    })) {
      const file = path.join(process.env.PSTACK_ROOT, 'skills', relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    configPath = path.join(sandbox.root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ roles: {}, timeouts: {} }));
    process.env.ZEDPSTACK_CONFIG = configPath;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('resolves how-explorer from the worker sheet when config.roles is empty', async () => {
    const { manifest } = await runPlaybook({
      playbookId: 'how-investigation',
      goal: 'How?',
      repoRoot: sandbox.repo,
      runId: 'sheet-only',
    });
    const explore = manifest.steps.find((step) => step.stepId === 'explore');
    assert.equal(explore.binding.runtime, 'codex');
    assert.equal(explore.binding.model, 'gpt-6.1-sol');
  });
});
