import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canReuseCompletedStep } from '../src/resume.mjs';

describe('resume regression (Codex P1)', () => {
  it('does not reuse completed step when result.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-resume-'));
    const resultPath = path.join(dir, 'result.json');
    const stepRecord = {
      status: 'completed',
      validResult: true,
      stepIdentityHash: 'abc',
    };
    const out = canReuseCompletedStep({
      stepRecord,
      stepIdentityHash: 'abc',
      resultPath,
      outputContract: 'markdown-report',
      role: 'explorer',
      stdoutLogPath: null,
    });
    assert.equal(out.reuse, false);
    assert.equal(out.reason, 'result_missing');
  });

  it('does not reuse when identity hash differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-resume-'));
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: true,
        text: '# Report\n\n' + 'capas app features entities shared '.repeat(3),
        signals: { readSuccess: 1 },
      }),
    );
    const stepRecord = {
      status: 'completed',
      validResult: true,
      stepIdentityHash: 'old-hash',
    };
    const out = canReuseCompletedStep({
      stepRecord,
      stepIdentityHash: 'new-hash',
      resultPath,
      outputContract: 'markdown-report',
      role: 'explorer',
      stdoutLogPath: null,
    });
    assert.equal(out.reuse, false);
    assert.equal(out.reason, 'identity_mismatch');
  });

  it('reuses when identity matches and result still valid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-resume-'));
    const resultPath = path.join(dir, 'result.json');
    const text =
      '# Architecture\n\n' +
      'Capas app → features → entities → shared con transporte y auth (src/auth/session.ts).\n';
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: true, text, signals: { readSuccess: 2 } }),
    );
    const hash = 'same';
    const stepRecord = {
      status: 'completed',
      validResult: true,
      stepIdentityHash: hash,
    };
    const out = canReuseCompletedStep({
      stepRecord,
      stepIdentityHash: hash,
      resultPath,
      outputContract: 'markdown-report',
      role: 'explorer',
      stdoutLogPath: null,
    });
    assert.equal(out.reuse, true);
  });
});
