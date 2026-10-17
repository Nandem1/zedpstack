import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPrompt, effortFromSubagentType, normalizeSubagentType } from '../src/agents/prompt.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

describe('agent prompt', () => {
  before(() => makeSandbox());

  it('maps pstack subagent types', () => {
    assert.equal(normalizeSubagentType('pstack:poteto-agent'), 'poteto-agent');
    assert.equal(normalizeSubagentType('pstack:poteto-agent-xhigh'), 'poteto-agent');
    assert.equal(normalizeSubagentType('pstack:effort-high'), 'general-purpose');
    assert.equal(normalizeSubagentType(undefined), 'general-purpose');
    assert.equal(effortFromSubagentType('pstack:effort-max'), 'max');
    assert.throws(() => normalizeSubagentType('Explore'), /unknown subagent_type/);
  });

  it('points poteto-agent at poteto-mode and lists extra skills', () => {
    const text = buildAgentPrompt({
      task: 'Do X',
      subagentType: 'poteto-agent',
      skills: ['how'],
      readonly: true,
      cwd: '/repo',
      runtime: 'codex',
      model: 'gpt-6.1-sol',
    });
    assert.match(text, /poteto-mode\/SKILL\.md/);
    assert.match(text, /how\/SKILL\.md/);
    assert.match(text, /You are read-only/);
    assert.match(text, /## Task\n\nDo X/);
  });

  it('tells worktree writers not to commit', () => {
    const text = buildAgentPrompt({
      task: 'Fix',
      subagentType: 'general-purpose',
      readonly: false,
      cwd: '/wt',
      worktree: { branch: 'zedpstack/a' },
      runtime: 'claude',
      model: 'sonnet',
    });
    assert.match(text, /branch zedpstack\/a/);
    assert.match(text, /do not commit/);
  });
});
