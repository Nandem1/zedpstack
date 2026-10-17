import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';

/** Run-level events that end `watch` when `follow` is true. */
export const TERMINAL_RUN_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

const HUMAN_TYPES = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.awaiting_judgment',
  'step.started',
  'step.completed',
  'step.failed',
  'step.validated',
  'worker.spawned',
  'worker.completed',
  'worker.failed',
  'worker.timeout',
  'worker.output',
  'worker.stderr',
]);

export function shouldDisplayEvent(type) {
  return Boolean(type && HUMAN_TYPES.has(type));
}

export function isTerminalRunEvent(type) {
  return TERMINAL_RUN_EVENTS.has(type);
}

function previewChunk(chunk, maxLen = 120) {
  const preview = chunk.replace(/\s+/g, ' ').slice(0, maxLen);
  return `${preview}${chunk.length > maxLen ? '…' : ''}`;
}

export function formatEvent(event) {
  const { ts, type, stepId, workerId, runtime, model, status, errors, chunk } = event;
  const head = `[${ts}] ${type}`;
  const parts = [head];
  if (stepId) parts.push(`step=${stepId}`);
  if (workerId) parts.push(`worker=${workerId}`);
  if (runtime) parts.push(`${runtime}/${model ?? '?'}`);
  if (status) parts.push(`status=${status}`);
  if (errors?.length) parts.push(`errors=${errors.join('; ')}`);
  if ((type === 'worker.output' || type === 'worker.stderr') && chunk) {
    parts.push(`| ${previewChunk(chunk)}`);
  }
  return parts.join(' ');
}

function readGrowth(eventsPath, offset, buf) {
  let nextOffset = offset;
  let buffer = buf;
  let st = fs.statSync(eventsPath);
  while (st.size > nextOffset) {
    const fd = fs.openSync(eventsPath, 'r');
    const len = st.size - nextOffset;
    const chunk = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, chunk, 0, len, nextOffset);
    fs.closeSync(fd);
    nextOffset += bytesRead;
    buffer += chunk.subarray(0, bytesRead).toString('utf8');
    st = fs.statSync(eventsPath);
  }
  return { offset: nextOffset, buf: buffer };
}

/**
 * Follow events.jsonl for a run (like tee-events, but readable).
 */
export async function watchRun({
  repoRoot,
  runId,
  fromStart = false,
  follow = true,
  pollMs = 500,
  writeLine = (line) => process.stderr.write(`${line}\n`),
}) {
  const eventsPath = path.join(runDir(repoRoot, runId), 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`No events at ${eventsPath}`);
  }

  let offset = fromStart ? 0 : fs.statSync(eventsPath).size;
  let buf = '';
  let sawTerminal = false;

  const drain = () => {
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (shouldDisplayEvent(event.type)) {
        writeLine(formatEvent(event));
      }
      if (isTerminalRunEvent(event.type)) {
        sawTerminal = true;
      }
    }
  };

  const pull = () => {
    const grown = readGrowth(eventsPath, offset, buf);
    offset = grown.offset;
    buf = grown.buf;
    drain();
    return sawTerminal;
  };

  if (fromStart) {
    pull();
  }

  if (!follow) return;

  if (sawTerminal) return;

  return new Promise((resolve) => {
    let interval;
    const stop = () => {
      if (interval) clearInterval(interval);
      resolve();
    };

    const tick = () => {
      try {
        if (pull()) stop();
      } catch {
        stop();
      }
    };

    interval = setInterval(tick, pollMs);
    tick();

    process.on('SIGINT', () => {
      stop();
    });
  });
}
