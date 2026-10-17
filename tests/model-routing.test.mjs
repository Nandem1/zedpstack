import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModelSlug,
  validateModelForRuntime,
} from '../src/modelRouting.mjs';
import { inferRuntimeForModel } from '../src/modelSheet.mjs';

describe('modelRouting', () => {
  it('routes Anthropic CLI slugs to claude runtime', () => {
    assert.equal(classifyModelSlug('haiku').runtime, 'claude');
    assert.equal(classifyModelSlug('sonnet').runtime, 'claude');
    assert.equal(classifyModelSlug('opus').runtime, 'claude');
  });

  it('routes OpenAI slugs to codex runtime', () => {
    assert.equal(classifyModelSlug('gpt-6.1-sol').runtime, 'codex');
  });

  it('routes Cursor panel slugs to cursor runtime', () => {
    assert.equal(classifyModelSlug('composer-2.5').runtime, 'cursor');
    assert.equal(classifyModelSlug('cursor-grok-4.6-high').runtime, 'cursor');
    assert.equal(classifyModelSlug('grok-4.7-high').runtime, 'cursor');
  });

  it('inferRuntimeForModel matches classify', () => {
    assert.equal(inferRuntimeForModel('composer-2.5'), 'cursor');
    assert.equal(inferRuntimeForModel('haiku'), 'claude');
  });

  it('validateModelForRuntime catches mismatches', () => {
    const bad = validateModelForRuntime('composer-2.5', 'claude');
    assert.equal(bad.ok, false);
    assert.equal(bad.inferred, 'cursor');
  });
});

describe('modelRouting edge cases', () => {
  it('keeps full Claude ids and gpt-5.x on their native CLIs', () => {
    assert.equal(classifyModelSlug('claude-opus-5-5').runtime, 'claude');
    assert.equal(classifyModelSlug('claude-sonnet-5-5').runtime, 'claude');
    assert.equal(classifyModelSlug('gpt-5.5').runtime, 'codex');
    assert.equal(classifyModelSlug('gpt-6-astra').runtime, 'codex');
  });

  it('an explicit prefix wins and is stripped from the model', () => {
    const r = classifyModelSlug('cursor:claude-opus-5-5');
    assert.deepEqual([r.runtime, r.model], ['cursor', 'claude-opus-5-5']);
  });

  it('unknown slugs are low confidence and never fail validation', () => {
    assert.equal(classifyModelSlug('mystery-9').confident, false);
    assert.equal(validateModelForRuntime('mystery-9', 'cursor').ok, true);
  });
});
