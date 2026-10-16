import fs from 'node:fs';
import path from 'node:path';
import { readManifest, writeManifestAtomic } from './manifest.mjs';
import { runDir } from './paths.mjs';
import { EventSink } from './events/sink.mjs';

export function terminateWorkerPid(pid) {
  if (typeof pid !== 'number' || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // proceso ya terminó
    }
  }, 5000);
}

function findActivePid(manifest) {
  const running = manifest.steps.find((s) => s.status === 'running');
  if (!running?.attempts?.length) {
    return null;
  }
  const last = running.attempts[running.attempts.length - 1];
  return last.pid ?? null;
}

export function cancelRun({ repoRoot, runId }) {
  const runRoot = runDir(repoRoot, runId);
  const manifestPath = path.join(runRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const manifest = readManifest(runRoot);
  if (manifest.status === 'completed') {
    return { manifest, alreadyTerminal: true };
  }
  if (manifest.status === 'cancelled') {
    return { manifest, alreadyTerminal: true };
  }

  const pid = findActivePid(manifest);
  if (pid) {
    terminateWorkerPid(pid);
  }

  manifest.status = 'cancelled';
  manifest.updatedAt = new Date().toISOString();
  writeManifestAtomic(runRoot, manifest);

  const eventSink = new EventSink(runRoot);
  eventSink.emit('run.cancelled', { runId, pid: pid ?? null });

  return { manifest, alreadyTerminal: false };
}
