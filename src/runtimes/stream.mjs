import fs from 'node:fs';

export function appendChunk(filePath, chunk) {
  fs.appendFileSync(filePath, chunk);
}

/**
 * @returns {{ chunk: string, terminalResult: string | null }}
 */
export function extractClaudeStreamText(line) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'result' && typeof obj.result === 'string') {
      return { chunk: '', terminalResult: obj.result };
    }
    if (obj.type === 'assistant' && obj.message?.content) {
      const chunk = obj.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return { chunk, terminalResult: null };
    }
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
      return { chunk: obj.delta.text ?? '', terminalResult: null };
    }
  } catch {
    return { chunk: '', terminalResult: null };
  }
  return { chunk: '', terminalResult: null };
}

export function accumulateClaudeSignals(line, signals) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use' && ['Read', 'Grep', 'Glob'].includes(block.name)) {
          signals.readAttempts += 1;
        }
      }
    }
    if (obj.type === 'user' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          signals.readDenied += 1;
        }
        if (block.type === 'tool_result' && !block.is_error && block.tool_use_id) {
          signals.readSuccess += 1;
        }
      }
    }
  } catch {
    // ignore non-json lines
  }
}
