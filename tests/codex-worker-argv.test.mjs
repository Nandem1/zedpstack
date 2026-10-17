import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgv } from '../src/permissions.mjs';

describe('codex worker argv contract', () => {
  it('worker appends stdin placeholder after buildCodexArgv', () => {
    const argv = [...buildCodexArgv({
      model: 'gpt-6.1-sol',
      repoRoot: '/tmp/repo',
      permissionProfile: 'read-only',
      resultOutPath: '/tmp/out.txt',
    }), '-'];
    assert.equal(argv.at(-1), '-');
  });
});
