import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorkerResult } from '../src/validation.mjs';

describe('validateWorkerResult', () => {
  it('rejects exit 0 with empty text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-'));
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: true, text: 'short' }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
    });
    assert.equal(v.valid, false);
  });

  it('accepts valid markdown report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-'));
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: true,
        text: '# Title\n\n' + 'x'.repeat(40),
      }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
    });
    assert.equal(v.valid, true);
  });
});
