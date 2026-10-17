import fs from 'node:fs';
import path from 'node:path';
import { formatHumanProgressEvent } from './progressUi.mjs';

export const PROGRESS_LOG_FILE = 'progress.log';

const PROGRESS_EVENT_TYPES = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.awaiting_judgment',
  'step.started',
  'step.completed',
  'step.failed',
  'worker.spawned',
  'worker.completed',
  'worker.failed',
  'worker.timeout',
  'worker.output',
]);

/**
 * Append human-readable line to run progress.log (for IDE orchestrators that
 * cannot stream subprocess stderr).
 * @param {string} runRoot
 * @param {Record<string, unknown>} event
 */
export function appendProgressLog(runRoot, event) {
  if (!PROGRESS_EVENT_TYPES.has(event.type)) return;
  const human = formatHumanProgressEvent(event);
  if (!human) return;
  const logPath = path.join(runRoot, PROGRESS_LOG_FILE);
  fs.appendFileSync(logPath, `${human}\n`, 'utf8');
}

/**
 * Read progress.log from byte offset.
 * @returns {{ text: string, nextOffset: number }}
 */
export function readProgressLog(runRoot, offset = 0) {
  const logPath = path.join(runRoot, PROGRESS_LOG_FILE);
  if (!fs.existsSync(logPath)) {
    return { text: '', nextOffset: 0 };
  }
  const st = fs.statSync(logPath);
  if (st.size <= offset) {
    return { text: '', nextOffset: offset };
  }
  const fd = fs.openSync(logPath, 'r');
  const len = st.size - offset;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);
  return { text: buf.toString('utf8'), nextOffset: st.size };
}
