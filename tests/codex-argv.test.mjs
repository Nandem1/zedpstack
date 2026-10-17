import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgv } from '../src/permissions.mjs';

describe('buildCodexArgv', () => {
  it('does not embed prompt text in argv (stdin is added by codex worker)', () => {
    const argv = buildCodexArgv({
      model: 'gpt-6.1-sol',
      repoRoot: '/tmp/repo',
      permissionProfile: 'read-only',
      resultOutPath: '/tmp/out.txt',
    });
    assert.equal(argv[argv.length - 1], '/tmp/out.txt');
    assert.ok(argv.every((a) => a.length < 500));
  });

  it('passes supported reasoning effort via -c', () => {
    const argv = buildCodexArgv({
      model: 'gpt-6.1-sol',
      repoRoot: '/tmp/repo',
      permissionProfile: 'read-only',
      resultOutPath: '/tmp/out.txt',
      effort: 'high',
    });
    assert.ok(argv.includes('-c'));
    assert.ok(argv.some((a) => a.includes('model_reasoning_effort')));
  });
});
