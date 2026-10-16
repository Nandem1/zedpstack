import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingsFromSheet,
  inferRuntimeForModel,
  parseModelSheet,
  parseModelValue,
} from '../src/modelSheet.mjs';

describe('modelSheet', () => {
  it('parses effort suffix', () => {
    assert.deepEqual(parseModelValue('opus @high'), { model: 'opus', effort: 'high' });
  });

  it('maps sheet to zedpstack bindings', () => {
    const parsed = parseModelSheet(`
how explorer: haiku
how explainer: gpt-6.1-sol
interrogate reviewers: haiku, gpt-6.1-sol, haiku
default effort: session
`);
    const bindings = bindingsFromSheet(parsed);
    assert.equal(bindings['how-explorer'].runtime, 'claude');
    assert.equal(bindings['how-explainer'].runtime, 'codex');
    assert.equal(bindings['interrogate-reviewer-b'].model, 'gpt-6.1-sol');
  });

  it('infers codex for gpt slugs', () => {
    assert.equal(inferRuntimeForModel('gpt-6.1-sol'), 'codex');
    assert.equal(inferRuntimeForModel('haiku'), 'claude');
  });
});
