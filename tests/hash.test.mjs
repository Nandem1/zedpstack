import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStepIdentity, sha256Hex } from '../src/hash.mjs';

describe('hash', () => {
  it('sha256Hex is stable', () => {
    assert.equal(sha256Hex('a'), sha256Hex('a'));
    assert.notEqual(sha256Hex('a'), sha256Hex('b'));
  });

  it('identity changes when binding model changes', () => {
    const base = {
      playbookId: 'architecture-review',
      playbookVersion: 1,
      stepId: 'explore',
      goal: 'g',
      inputRefs: [],
      binding: { runtime: 'claude', model: 'haiku', permissionProfile: 'read-only' },
      renderedPrompt: 'prompt-a',
    };
    const a = computeStepIdentity(base);
    const b = computeStepIdentity({ ...base, binding: { ...base.binding, model: 'opus' } });
    assert.notEqual(a, b);
  });

  it('identity changes when repo source fingerprint changes', () => {
    const base = {
      playbookId: 'architecture-review',
      playbookVersion: 1,
      stepId: 'explore',
      goal: 'g',
      inputRefs: [],
      binding: { runtime: 'claude', model: 'haiku', permissionProfile: 'read-only' },
      renderedPrompt: 'prompt-a',
      repoCommit: 'abc',
      repoSourceFingerprint: 'fp1',
    };
    const a = computeStepIdentity(base);
    const b = computeStepIdentity({ ...base, repoSourceFingerprint: 'fp2' });
    assert.notEqual(a, b);
  });

  it('identity changes when rendered prompt changes', () => {
    const base = {
      playbookId: 'architecture-review',
      playbookVersion: 1,
      stepId: 'explore',
      goal: 'g',
      inputRefs: [],
      binding: { runtime: 'claude', model: 'haiku', permissionProfile: 'read-only' },
      renderedPrompt: 'prompt-a',
    };
    const a = computeStepIdentity(base);
    const b = computeStepIdentity({ ...base, renderedPrompt: 'prompt-b' });
    assert.notEqual(a, b);
  });
});
