import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';

const HUMAN_TYPES = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'step.started',
  'step.completed',
  'step.failed',
  'worker.spawned',
  'worker.finished',
  'worker.timeout',
  'judgment.awaiting',
]);

function formatEvent(event) {
  const { ts, type, stepId, workerId, runtime, model, status, errors, chunk } = event;
  const head = `[${ts}] ${type}`;
  const parts = [head];
  if (stepId) parts.push(`step=${stepId}`);
  if (workerId) parts.push(`worker=${workerId}`);
  if (runtime) parts.push(`${runtime}/${model ?? '?'}`);
  if (status) parts.push(`status=${status}`);
  if (errors?.length) parts.push(`errors=${errors.join('; ')}`);
  if (type === 'worker.output' && chunk) {
    const preview = chunk.replace(/\s+/g, ' ').slice(0, 120);
    parts.push(`| ${preview}${chunk.length > 120 ? '…' : ''}`);
  }
  return parts.join(' ');
}

/**
 * Follow events.jsonl for a run (like tee-events, but readable).
 */
export async function watchRun({
  repoRoot,
  runId,
  fromStart = false,
  follow = true,
}) {
  const eventsPath = path.join(runDir(repoRoot, runId), 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`No events at ${eventsPath}`);
  }

  let offset = fromStart ? 0 : fs.statSync(eventsPath).size;
  let buf = '';

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
      if (HUMAN_TYPES.has(event.type) || event.type?.startsWith('worker.')) {
        process.stderr.write(`${formatEvent(event)}\n`);
      }
    }
  };

  if (fromStart) {
    buf = fs.readFileSync(eventsPath, 'utf8');
    drain();
    offset = fs.statSync(eventsPath).size;
  }

  if (!follow) return;

  return new Promise((resolve) => {
    const tick = () => {
      const st = fs.statSync(eventsPath);
      if (st.size > offset) {
        const fd = fs.openSync(eventsPath, 'r');
        const len = st.size - offset;
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, offset);
        fs.closeSync(fd);
        offset = st.size;
        buf += chunk.toString('utf8');
        drain();
      }
    };
    const interval = setInterval(tick, 500);
    process.on('SIGINT', () => {
      clearInterval(interval);
      resolve();
    });
  });
}
