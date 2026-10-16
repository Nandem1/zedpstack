import fs from 'node:fs';
import { sha256Hex } from './hash.mjs';

/** Instrucciones para el orquestador (no es el veredicto). */
export const JUDGMENT_INSTRUCTIONS_FILE = 'JUDGMENT_INSTRUCTIONS.md';

/** Veredicto generado por el orquestador activo. */
export const ORCHESTRATOR_JUDGMENT_FILE = 'orchestrator-judgment.md';

const INSTRUCTION_MARKERS = [
  'El dispatcher completó workers read-only',
  'dispatch.mjs judgment --run-id',
];

export function validateOrchestratorJudgment({ instructionsPath, judgmentPath }) {
  const errors = [];
  if (!fs.existsSync(judgmentPath)) {
    return { valid: false, errors: ['orchestrator-judgment.md missing'] };
  }
  const judgment = fs.readFileSync(judgmentPath, 'utf8').trim();
  const instructions = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, 'utf8').trim()
    : '';

  if (judgment.length < 80) {
    errors.push('judgment too short');
  }
  if (instructions && judgment === instructions) {
    errors.push('judgment identical to instructions template');
  }
  if (instructions && sha256Hex(judgment) === sha256Hex(instructions)) {
    errors.push('judgment hash matches instructions');
  }
  for (const marker of INSTRUCTION_MARKERS) {
    if (judgment.includes(marker)) {
      errors.push('judgment contains instruction-only marker');
    }
  }
  if (judgment.includes('<ZEDPSTACK_ROOT>') || judgment.includes('<RUN_ID>')) {
    errors.push('judgment contains unresolved template placeholders');
  }

  return { valid: errors.length === 0, errors, judgment };
}
