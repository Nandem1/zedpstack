import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorkerResult } from '../src/validation.mjs';

describe('digest reviewer validation', () => {
  it('accepts terse interrogate-reviewer-a without repo reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rev-'));
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: true,
        text: '## Findings\n\nNo issues.',
        signals: { readSuccess: 0, readDenied: 1 },
      }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
      role: 'interrogate-reviewer-a',
      validationProfile: 'explorer',
    });
    assert.equal(v.valid, true);
  });
});
