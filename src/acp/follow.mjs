import fs from 'node:fs';
import path from 'node:path';
import { agentStatus } from '../agents/lifecycle.mjs';
import { TERMINAL_AGENT_STATUSES, agentDir } from '../agents/store.mjs';
import { readProgressLog } from '../progressLog.mjs';

function readFileTail(runRoot, fileName, offset) {
  const logPath = path.join(runRoot, fileName);
  if (!fs.existsSync(logPath)) return { text: '', nextOffset: offset };
  const st = fs.statSync(logPath);
  if (st.size <= offset) return { text: '', nextOffset: offset };
  const fd = fs.openSync(logPath, 'r');
  const len = st.size - offset;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);
  return { text: buf.toString('utf8'), nextOffset: st.size };
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Poll agent state and tail progress.log / stdout.log until terminal or aborted.
 *
 * @param {string} repo
 * @param {string} id
 * @param {(event: { type: 'activity'|'output'|'status', line?: string, text?: string, status?: string, summary?: object }) => void} onEvent
 * @param {{ signal?: AbortSignal, intervalMs?: number }} [opts]
 */
export async function followAgent(repo, id, onEvent, { signal, intervalMs = 300 } = {}) {
  const dir = agentDir(repo, id);
  let progressOffset = 0;
  let stdoutOffset = 0;
  let lastStatus = null;

  for (;;) {
    if (signal?.aborted) break;
    const summary = agentStatus({ repo, id });
    if (summary.status !== lastStatus) {
      lastStatus = summary.status;
      onEvent({ type: 'status', status: summary.status, summary });
    }

    const prog = readProgressLog(dir, progressOffset);
    if (prog.text) {
      progressOffset = prog.nextOffset;
      for (const line of prog.text.split('\n').filter(Boolean)) {
        onEvent({ type: 'activity', line });
      }
    }

    const out = readFileTail(dir, 'stdout.log', stdoutOffset);
    if (out.text) {
      stdoutOffset = out.nextOffset;
      onEvent({ type: 'output', text: out.text });
    }

    if (TERMINAL_AGENT_STATUSES.has(summary.status)) break;
    await sleep(intervalMs, signal);
  }
}
