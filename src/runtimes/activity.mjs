/**
 * Turn raw worker output into short human activity lines ("> Inspecting
 * src/run.mjs", "· Tracing the write path") and the effective model the CLI
 * reports, which can differ from the requested alias.
 */

import { activityFromStreamJsonLine } from '../progressUi.mjs';

const MAX_ACTIVITY = 96;

/** First sentence of narration, single line, clipped. */
export function narrationLine(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const sentence = flat.match(/^(.+?[.!?:])(\s|$)/)?.[1] ?? flat;
  const clipped = sentence.length > MAX_ACTIVITY ? `${sentence.slice(0, MAX_ACTIVITY - 1)}…` : sentence;
  return `· ${clipped}`;
}

function codexCommand(line) {
  const m = /^\/bin\/(?:z|ba)?sh\s+-lc\s+(['"])([\s\S]*?)\1(?:\s+in\s+.*)?$/.exec(line.trim());
  const cmd = (m ? m[2] : line.trim()).replace(/\s+/g, ' ');
  return `> Running ${cmd.length > 72 ? `${cmd.slice(0, 71)}…` : cmd}`;
}

/**
 * @param {string} runtime
 * @param {{ onActivity?: (line: string) => void, onMeta?: (meta: { effectiveModel: string }) => void }} hooks
 */
export function createActivityParser(runtime, { onActivity = () => {}, onMeta = () => {} } = {}) {
  let metaSent = false;
  const meta = (model) => {
    if (metaSent || !model) return;
    metaSent = true;
    onMeta({ effectiveModel: model });
  };

  if (runtime !== 'codex') {
    let thinking = '';
    return {
      stdoutLine(line) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        if (obj.type === 'system' && obj.subtype === 'init') meta(obj.model);
        // Cursor streams its narration as thinking deltas; surface each finished thought.
        if (obj.type === 'thinking') {
          if (obj.subtype === 'delta') thinking += obj.text ?? '';
          if (obj.subtype === 'completed') {
            const narration = narrationLine(thinking);
            thinking = '';
            if (narration) onActivity(narration);
          }
          return;
        }
        const tool = activityFromStreamJsonLine(line);
        if (tool) {
          onActivity(tool);
          return;
        }
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const text = obj.message.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
          const narration = narrationLine(text);
          if (narration) onActivity(narration);
        }
      },
      stderrChunk() {},
    };
  }

  let section = null;
  let buf = '';
  return {
    stdoutLine() {},
    stderrChunk(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (!metaSent && /^model: /.test(line)) meta(line.slice(7).trim());
        if (line === 'exec' || line === 'codex' || line === 'thinking' || line === 'user') {
          section = line;
          continue;
        }
        if (!line.trim() || line.startsWith('hook: ')) continue;
        if (section === 'exec') {
          onActivity(codexCommand(line));
          section = null;
        } else if (section === 'codex') {
          const narration = narrationLine(line);
          if (narration) onActivity(narration);
          section = null;
        }
      }
    },
  };
}
