import fs from 'node:fs';

const BLOCKED_PHRASES = [
  'permiso de lectura',
  'permitir el acceso',
  'permitir acceso',
  'blocking the readings',
  'no pude leer',
  'denied reading',
  'permission deny',
  '¿podrías permitir',
  'could you allow',
  'need access to read',
  'bloqueando las lecturas',
];

const EXPLORER_EVIDENCE = [
  'app',
  'features',
  'entities',
  'shared',
  'AGENTS',
  'transporte',
  'auth',
  'capas',
];

export function detectBlockedOutput(text) {
  const lower = text.toLowerCase();
  return BLOCKED_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
}

export function explorerShowsRepoEvidence(text) {
  const lower = text.toLowerCase();
  return EXPLORER_EVIDENCE.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * exit_code === 0 is necessary but not sufficient.
 */
export function validateWorkerResult({
  exitCode,
  resultPath,
  outputContract,
  processExited,
  role = null,
  stdoutLogPath = null,
}) {
  const errors = [];
  const stages = {
    processExited: false,
    exitOk: false,
    parsed: false,
    taskExecuted: false,
  };

  if (!processExited) {
    errors.push('process did not exit cleanly');
  } else {
    stages.processExited = true;
  }
  if (exitCode !== 0) {
    errors.push(`exit_code=${exitCode}`);
  } else {
    stages.exitOk = true;
  }
  if (!fs.existsSync(resultPath)) {
    errors.push('result.json missing');
    return { valid: false, errors, result: null, stages };
  }

  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    stages.parsed = true;
  } catch {
    errors.push('result.json not parseable');
    return { valid: false, errors, result: null, stages };
  }

  if (!result || typeof result !== 'object') {
    errors.push('result.json empty or not an object');
    return { valid: false, errors, result: null, stages };
  }

  const textIsString = typeof result.text === 'string';
  if (!textIsString) {
    errors.push('result.text must be a string');
  } else if (result.text.trim().length < 32) {
    errors.push('result.text missing or too short');
  }
  if (result.ok !== true) {
    errors.push('result.ok is not true');
  }
  if (textIsString && outputContract === 'markdown-report' && !result.text.includes('\n')) {
    errors.push('markdown-report expected multiline text');
  }

  if (textIsString) {
    const blocked = detectBlockedOutput(result.text);
    if (blocked.length) {
      errors.push(`blocked_phrases:${blocked.join('|')}`);
    }
  }

  if (stdoutLogPath && fs.existsSync(stdoutLogPath)) {
    const log = fs.readFileSync(stdoutLogPath, 'utf8');
    if (log.includes('Permission deny') || log.includes('"is_error":true')) {
      errors.push('stdout indicates tool permission errors');
    }
  }

  if (result.signals?.readDenied > 0 && (result.signals?.readSuccess ?? 0) === 0) {
    errors.push('read tools denied without successful read');
  }

  if (role === 'explorer' && textIsString) {
    const reads = result.signals?.readSuccess ?? 0;
    if (reads < 1) {
      errors.push('explorer: requires at least one successful Read/Grep/Glob execution');
    }
    if (!explorerShowsRepoEvidence(result.text)) {
      errors.push('explorer: missing architectural evidence in output');
    }
  }

  if (role === 'synthesizer' && result.signals?.shellInvoked === true) {
    errors.push('synthesizer: shell/tool invocation detected (read-only policy)');
  }

  stages.taskExecuted =
    stages.processExited && stages.exitOk && stages.parsed && errors.length === 0;

  return {
    valid: errors.length === 0,
    errors,
    result,
    stages,
  };
}
