import fs from 'node:fs';
import { readManifest } from './manifest.mjs';
import { readProgressLog } from './progressLog.mjs';
import { runDir } from './paths.mjs';
import { TERMINAL_RUN_EVENTS } from './watchRun.mjs';

/**
 * Print new progress.log lines since offset; returns next offset and terminal flag.
 */
export function tailProgressOnce({ repoRoot, runId, offset = 0 }) {
  const runRoot = runDir(repoRoot, runId);
  const { text, nextOffset } = readProgressLog(runRoot, offset);
  let terminal = false;
  try {
    const manifest = readManifest(runRoot);
    terminal = ['completed', 'failed', 'cancelled', 'awaiting_judgment'].includes(
      manifest.status,
    );
  } catch {
    // manifest not ready
  }
  return { text, nextOffset, terminal, runRoot };
}

/**
 * Follow progress.log until run terminal or timeout.
 */
export async function followProgress({
  repoRoot,
  runId,
  fromStart = true,
  pollMs = 800,
  maxMs = 600_000,
  writeLine = (line) => process.stdout.write(`${line}\n`),
}) {
  const runRoot = runDir(repoRoot, runId);
  let offset = fromStart ? 0 : fs.existsSync(runRoot) ? Infinity : 0;
  if (!fromStart && offset === Infinity) {
    const logPath = `${runRoot}/progress.log`;
    offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  }

  const started = Date.now();
  let done = false;

  while (!done && Date.now() - started < maxMs) {
    const { text, nextOffset, terminal } = tailProgressOnce({
      repoRoot,
      runId,
      offset,
    });
    offset = nextOffset;
    if (text) {
      for (const line of text.split('\n')) {
        if (line.trim()) writeLine(line);
      }
    }
    if (terminal) {
      done = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
