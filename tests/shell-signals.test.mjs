import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyShellCommand,
  detectCodexShellInvocation,
  detectCodexShellMutation,
  extractCodexExecCommands,
  synthesizerShellPolicyViolation,
} from '../src/shellSignals.mjs';

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

  it('classifies rg exec as read-only verification', () => {
    const stderr =
      'exec\n/bin/zsh -lc "rg -n getDashboardAccess src/" in /repo\n succeeded in 0ms:\n';
    assert.deepEqual(extractCodexExecCommands(stderr), ['rg -n getDashboardAccess src/']);
    assert.equal(classifyShellCommand('rg -n foo'), 'readonly');
    assert.equal(detectCodexShellMutation(stderr), false);
  });

  it('flags mutating git exec', () => {
    const stderr =
      'exec\n/bin/zsh -lc "git commit -m test" in /repo\n succeeded in 0ms:\n';
    assert.equal(detectCodexShellMutation(stderr), true);
  });

  it('allows synthesizer when shell was read-only only', () => {
    assert.equal(
      synthesizerShellPolicyViolation({
        shellInvoked: true,
        shellMutationInvoked: false,
      }),
      false,
    );
    assert.equal(
      synthesizerShellPolicyViolation({
        shellInvoked: true,
        shellMutationInvoked: true,
      }),
      true,
    );
  });
});
