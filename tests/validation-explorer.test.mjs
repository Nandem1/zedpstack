import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorkerResult } from '../src/validation.mjs';

describe('explorer validation', () => {
  it('rejects permission-blocked explorer output from session 1 run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-val-'));
    const resultPath = path.join(dir, 'result.json');
    const blockedText =
      'Necesito acceso de lectura. ¿Podrías permitir el acceso a Read?\n' +
      'Los archivos críticos son AGENTS.md\n'.repeat(2);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ ok: true, text: blockedText, signals: { readDenied: 3, readSuccess: 0 } }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
      role: 'explorer',
    });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes('blocked_phrases')));
  });

  it('rejects filler report without read execution (Codex P1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-val-'));
    const resultPath = path.join(dir, 'result.json');
    const filler =
      '# Informe\n\nLa app sigue sin analizarse; esto es un reporte de relleno con features.\n';
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        ok: true,
        text: filler,
        signals: { readAttempts: 0, readSuccess: 0, readDenied: 0 },
      }),
    );
    const v = validateWorkerResult({
      exitCode: 0,
      resultPath,
      outputContract: 'markdown-report',
      processExited: true,
      role: 'explorer',
    });
    assert.equal(v.valid, false);
    assert.ok(
      v.errors.some((e) => e.includes('successful Read/Grep/Glob')),
    );
  });
});
