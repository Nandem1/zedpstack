const BOARD_FIRST_LINE_RE = /^(?:\/)?board\s*$/;
const SPAWN_FIRST_LINE_RE = /^(?:\/)?spawn(?:\s+x(\d+))?\s+(.+?)\s*::\s*(.*)$/;

export const USAGE_TEXT = [
  'Comandos zedpstack ACP (con o sin / inicial):',
  '  spawn <rol> :: <prompt>      — un worker',
  '  spawn xN <rol> :: <prompt>   — N workers en paralelo (N≤50)',
  '  board                        — tablero de agentes recientes',
  'La primera línea es la cabecera hasta ::; el prompt puede ocupar varias líneas.',
].join('\n');

export const AVAILABLE_COMMANDS = [
  {
    name: 'spawn',
    description: 'Lanza un worker: /spawn <rol> :: <prompt>  o  /spawn xN <rol> :: <prompt>',
    input: { hint: '<rol> :: <prompt>' },
  },
  { name: 'board', description: 'Tablero de agentes recientes' },
];

/**
 * @param {string} text
 * @returns {{ type: 'spawn', count: number, role: string, prompt: string } | { type: 'board' } | { type: 'usage' }}
 */
export function parsePromptCommand(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { type: 'usage' };

  const nl = raw.indexOf('\n');
  const firstLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : raw.slice(nl + 1);

  if (BOARD_FIRST_LINE_RE.test(firstLine)) return { type: 'board' };

  const m = firstLine.match(SPAWN_FIRST_LINE_RE);
  if (m) {
    const count = m[1] ? Math.min(50, Math.max(1, Number.parseInt(m[1], 10) || 1)) : 1;
    const role = m[2].trim();
    const headPrompt = m[3];
    const prompt = rest ? (headPrompt ? `${headPrompt}\n${rest}` : rest) : headPrompt;
    return { type: 'spawn', count, role, prompt };
  }
  return { type: 'usage' };
}
