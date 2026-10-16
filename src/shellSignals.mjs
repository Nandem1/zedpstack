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
