import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JUDGMENT_INSTRUCTIONS_FILE,
  ORCHESTRATOR_JUDGMENT_FILE,
  validateOrchestratorJudgment,
} from '../src/judgment.mjs';

describe('judgment', () => {
  it('rejects judgment identical to instructions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-j-'));
    const instructionsPath = path.join(dir, JUDGMENT_INSTRUCTIONS_FILE);
    const judgmentPath = path.join(dir, ORCHESTRATOR_JUDGMENT_FILE);
    const body = '# Judgment\n\nEl dispatcher completó workers read-only.\n'.repeat(5);
    fs.writeFileSync(instructionsPath, body);
    fs.writeFileSync(judgmentPath, body);
    const v = validateOrchestratorJudgment({ instructionsPath, judgmentPath });
    assert.equal(v.valid, false);
  });

  it('rejects judgment with instruction placeholders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-j-'));
    const instructionsPath = path.join(dir, JUDGMENT_INSTRUCTIONS_FILE);
    const judgmentPath = path.join(dir, ORCHESTRATOR_JUDGMENT_FILE);
    fs.writeFileSync(instructionsPath, 'template');
    fs.writeFileSync(
      judgmentPath,
      '## Veredicto\n\nOK\n\n## Evidencia\n\n- AGENTS.md\n- serverTransport\n- dashboardSession\n\nPlaceholder <RUN_ID> unresolved.\n',
    );
    const v = validateOrchestratorJudgment({ instructionsPath, judgmentPath });
    assert.equal(v.valid, false);
  });

  it('accepts distinct orchestrator judgment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-j-'));
    const instructionsPath = path.join(dir, JUDGMENT_INSTRUCTIONS_FILE);
    const judgmentPath = path.join(dir, ORCHESTRATOR_JUDGMENT_FILE);
    fs.writeFileSync(
      instructionsPath,
      'El dispatcher completó workers read-only. Escribe en orchestrator-judgment.md',
    );
    fs.writeFileSync(
      judgmentPath,
      '## Veredicto\n\nArquitectura sólida con riesgos acotados.\n\n## Evidencia\n\n- AGENTS.md capas\n- serverTransport\n- dashboardSession\n',
    );
    const v = validateOrchestratorJudgment({ instructionsPath, judgmentPath });
    assert.equal(v.valid, true);
  });
});
