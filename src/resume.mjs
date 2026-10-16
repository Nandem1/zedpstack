import fs from 'node:fs';
import path from 'node:path';
import { validateWorkerResult } from './validation.mjs';

/**
 * Un step completed solo se reutiliza si identidad, artefacto y validación coinciden.
 */
export function canReuseCompletedStep({
  stepRecord,
  stepIdentityHash,
  resultPath,
  outputContract,
  role,
  validationProfile = null,
  stdoutLogPath,
}) {
  if (stepRecord.status !== 'completed' || stepRecord.validResult !== true) {
    return { reuse: false, reason: 'not_completed' };
  }
  if (stepRecord.stepIdentityHash !== stepIdentityHash) {
    return { reuse: false, reason: 'identity_mismatch' };
  }
  if (!fs.existsSync(resultPath)) {
    return { reuse: false, reason: 'result_missing' };
  }

  const validation = validateWorkerResult({
    exitCode: 0,
    resultPath,
    outputContract,
    processExited: true,
    role,
    validationProfile: validationProfile ?? role,
    stdoutLogPath: fs.existsSync(stdoutLogPath) ? stdoutLogPath : null,
  });

  if (!validation.valid) {
    return { reuse: false, reason: 'result_invalid', errors: validation.errors };
  }

  return { reuse: true, validation };
}

export function resultPathForStep(runRoot, stepId) {
  return path.join(runRoot, 'workers', stepId, 'result.json');
}

export function stdoutLogForStep(runRoot, stepId) {
  return path.join(runRoot, 'workers', stepId, 'stdout.log');
}
