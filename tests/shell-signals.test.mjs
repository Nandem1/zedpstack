import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodexShellInvocation } from '../src/shellSignals.mjs';

describe('detectCodexShellInvocation', () => {
  it('detects codex tool success lines', () => {
    assert.equal(
      detectCodexShellInvocation('grep succeeded in 0ms:\npackage.json:1:foo'),
      true,
    );
  });

  it('detects multiline codex exec + succeeded', () => {
    const stderr = 'codex\nexec\n succeeded in 0ms:\npackage.json:1:foo';
    assert.equal(detectCodexShellInvocation(stderr), true);
  });

  it('ignores innocent citations', () => {
    assert.equal(
      detectCodexShellInvocation('El texto menciona package.json:17 sin herramientas'),
      false,
    );
  });
});
