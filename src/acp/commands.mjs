const BOARD_FIRST_LINE_RE = /^(?:\/)?board\s*$/;
const SLASH_FIRST_LINE_RE = /^\/(\S+)/;

function firstLine(text) {
  const raw = String(text ?? '');
  const nl = raw.indexOf('\n');
  return (nl === -1 ? raw : raw.slice(0, nl)).trim();
}

export function isBoardCommand(text) {
  return BOARD_FIRST_LINE_RE.test(firstLine(text));
}

const EDITS_FIRST_LINE_RE = /^\/edits(?:\s+(on|off))?\s*$/i;

/** `'on'`, `'off'`, `'status'` for a bare `/edits`, or null for any other prompt. */
export function parseEditsCommand(text) {
  const m = firstLine(text).match(EDITS_FIRST_LINE_RE);
  if (!m) return null;
  return m[1]?.toLowerCase() ?? 'status';
}

/** A `/name` prompt the engine announced in its own available_commands_update. */
export function isChildCommand(text, childCommands = []) {
  const name = firstLine(text).match(SLASH_FIRST_LINE_RE)?.[1];
  return Boolean(name) && (childCommands ?? []).some((command) => command.name === name);
}
