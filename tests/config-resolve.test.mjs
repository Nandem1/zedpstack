import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleBinding, resolveRoleBindingKey, resolveTimeout } from '../src/config.mjs';

describe('resolveRoleBinding', () => {
  const config = {
    data: {
      roles: {
        explorer: {
          runtime: 'claude',
          model: 'haiku',
          permissionProfile: 'read-only',
        },
        'interrogate-reviewer': {
          runtime: 'claude',
          model: 'sonnet',
          permissionProfile: 'read-only',
          effort: 'high',
        },
      },
      timeouts: {
        explorer: 120_000,
      },
    },
  };

  it('follows alias chain to binding', () => {
    assert.equal(
      resolveRoleBindingKey(config.data.roles, 'interrogate-reviewer-a'),
      'interrogate-reviewer',
    );
    const b = resolveRoleBinding(config, 'interrogate-reviewer-c');
    assert.equal(b.model, 'sonnet');
    assert.equal(b.effort, 'high');
  });

  it('resolves timeout through alias chain', () => {
    assert.equal(resolveTimeout(config, 'interrogate-reviewer-b'), 120_000);
  });

  it('architect runner c inherits its generic binding and timeout with explicit overrides', () => {
    assert.equal(resolveRoleBinding(config, 'architect-runner-c').model, 'haiku');
    assert.equal(resolveTimeout(config, 'architect-runner-c'), 120_000);
    const explicit = {
      data: {
        roles: { 'architect-runner': config.data.roles['interrogate-reviewer'] },
        timeouts: { 'architect-runner': 240_000, 'architect-runner-c': 360_000 },
      },
    };
    assert.equal(resolveRoleBinding(explicit, 'architect-runner-c').effort, 'high');
    assert.equal(resolveTimeout(explicit, 'architect-runner-c'), 360_000);
    delete explicit.data.timeouts['architect-runner-c'];
    assert.equal(resolveTimeout(explicit, 'architect-runner-c'), 240_000);
  });
});
