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
