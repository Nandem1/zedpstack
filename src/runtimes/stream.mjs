/**
 * Parsers for stream-json output. Claude Code and Cursor Agent share the
 * envelope (`assistant`, `user`, `result`); Cursor reports tools as
 * `tool_call` events instead of `tool_use` content blocks.
 */

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const CURSOR_READ_TOOL_KEYS = new Set(['readToolCall', 'grepToolCall', 'globToolCall', 'lsToolCall']);

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * @returns {{ chunk: string, terminalResult: string | null }}
 */
export function extractStreamText(line) {
  const obj = parse(line);
  if (!obj) return { chunk: '', terminalResult: null };
  if (obj.type === 'result' && typeof obj.result === 'string') {
    return { chunk: '', terminalResult: obj.result };
  }
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    const chunk = obj.message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return { chunk, terminalResult: null };
  }
  return { chunk: '', terminalResult: null };
}

export function accumulateStreamSignals(line, signals) {
  const obj = parse(line);
  if (!obj) return;
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_use' && READ_TOOLS.has(block.name)) {
        signals.readAttempts += 1;
      }
    }
  }
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type !== 'tool_result') continue;
      if (block.is_error) signals.readDenied += 1;
      else if (block.tool_use_id) signals.readSuccess += 1;
    }
  }
  if (obj.type === 'tool_call' && obj.tool_call) {
    const key = Object.keys(obj.tool_call)[0];
    if (!CURSOR_READ_TOOL_KEYS.has(key)) return;
    if (obj.subtype === 'started') signals.readAttempts += 1;
    if (obj.subtype === 'completed') {
      const result = obj.tool_call[key]?.result;
      if (result && !result.error && result.success !== undefined) signals.readSuccess += 1;
      else if (result?.error) signals.readDenied += 1;
    }
  }
}
