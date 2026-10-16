/**
 * Heurísticas para detectar invocación de herramientas shell en stderr de Codex.
 * Evita falsos positivos por texto citado sin el patrón de éxito de herramienta.
 */
export function detectCodexShellInvocation(stderrText) {
  if (typeof stderrText !== 'string' || stderrText.length === 0) {
    return false;
  }
  if (/Executing command/i.test(stderrText)) {
    return true;
  }
  if (/\bsucceeded in \d+ms:/m.test(stderrText)) {
    return true;
  }
  if (/(?:^|\n)\s*exec\s*(?:\n|$)/m.test(stderrText)) {
    return true;
  }
  return /\b[\w.-]+ succeeded in \d+ms:/m.test(stderrText);
}

/**
 * Extrae el comando tras líneas `exec` del log Codex (p. ej. `/bin/zsh -lc "rg …"`).
 */
export function extractCodexExecCommands(stderrText) {
  if (typeof stderrText !== 'string' || stderrText.length === 0) {
    return [];
  }
  const commands = [];
  const re = /(?:^|\n)exec\n([^\n]+)/g;
  let match;
  while ((match = re.exec(stderrText)) !== null) {
    const line = match[1].trim();
    if (!line || /^succeeded in \d+ms:/.test(line)) {
      continue;
    }
    const fromZsh = line.match(
      /\/bin\/zsh\s+-lc\s+(['"])([\s\S]*?)\1(?:\s+in\s+|$)/,
    );
    if (fromZsh) {
      commands.push(fromZsh[2]);
      continue;
    }
    commands.push(line);
  }
  return commands;
}

/**
 * @returns {'readonly' | 'mutation' | 'unknown'}
 */
export function classifyShellCommand(command) {
  const normalized = command.trim().replace(/^\s*sudo\s+/, '');
  if (!normalized) {
    return 'unknown';
  }
  if (/\s[<>]{1,2}\s*|\s>>/.test(normalized)) {
    return 'mutation';
  }
  if (
    /^\s*(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee|npm|npx|pnpm|yarn|bun)\b/.test(
      normalized,
    )
  ) {
    return 'mutation';
  }
  if (
    /^\s*git\s+(add|commit|push|pull|merge|rebase|checkout|switch|reset|clean|stash|cherry-pick|apply|am|revert|tag|init|clone)\b/.test(
      normalized,
    )
  ) {
    return 'mutation';
  }
  if (/^\s*sed\s+/.test(normalized) && /\s-i\b/.test(normalized)) {
    return 'mutation';
  }
  if (
    /^\s*git\s+(log|show|diff|blame|rev-parse|cat-file|ls-files|status|grep|shortlog|describe|name-rev)\b/.test(
      normalized,
    )
  ) {
    return 'readonly';
  }
  if (
    /^\s*(rg|grep|egrep|fgrep|ag|ack|cat|head|tail|less|more|bat|find|ls|stat|file|wc|pwd|which|type|sed|awk|nl)\b/.test(
      normalized,
    )
  ) {
    return 'readonly';
  }
  if (/^\s*git\s+show\b/.test(normalized)) {
    return 'readonly';
  }
  if (/^\s*gh\s+(pr view|api|repo view)\b/.test(normalized)) {
    return 'readonly';
  }
  return 'unknown';
}

/** True si algún `exec` del log parece mutar el workspace (no solo verificar). */
export function detectCodexShellMutation(stderrText) {
  const commands = extractCodexExecCommands(stderrText);
  if (commands.length === 0) {
    return false;
  }
  return commands.some((cmd) => classifyShellCommand(cmd) === 'mutation');
}

/** Señales de lectura para perfiles explorer cuando Codex usa shell read-only. */
export function accumulateCodexReadSignals(stderrText) {
  const commands = extractCodexExecCommands(stderrText);
  let readSuccess = 0;
  let readAttempts = 0;
  for (const cmd of commands) {
    if (classifyShellCommand(cmd) === 'readonly') {
      readAttempts += 1;
      readSuccess += 1;
    }
  }
  return { readAttempts, readSuccess, readDenied: 0 };
}

/**
 * Política read-only del perfil synthesizer (how-explainer, why-synthesizer, …).
 * - `shellMutationInvoked: false` → permitir (p. ej. rg para verificar hallazgos).
 * - Herramientas Codex sin línea `exec` (grep succeeded) → no cuenta como mutación.
 * - Resultados legacy con solo `shellInvoked: true` → bloquear (conservador).
 */
export function synthesizerShellPolicyViolation(signals) {
  if (!signals?.shellInvoked) {
    return false;
  }
  if (signals.shellMutationInvoked === false) {
    return false;
  }
  if (signals.shellMutationInvoked === true) {
    return true;
  }
  return true;
}
