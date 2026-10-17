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
});
