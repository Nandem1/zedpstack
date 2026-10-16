import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorkerResult } from '../src/validation.mjs';

describe('validateWorkerResult text type', () => {
  it('rejects non-string text without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-val-'));
    const resultPath = path.join(dir, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, text: null }));
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
      role: 'explorer',
    });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('result.text must be a string')));
  });

  it('rejects synthesizer when shellInvoked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-val-'));
    const resultPath = path.join(dir, 'result.json');
    const text = '# Synth\n\n' + 'contenido suficientemente largo para validar.\n';
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: true, text, signals: { shellInvoked: true } }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
      role: 'synthesizer',
    });
    assert.equal(v.valid, false);
  });
});
