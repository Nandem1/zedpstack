import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function zedpstackRoot() {
  if (process.env.ZEDPSTACK_ROOT) {
    return path.resolve(process.env.ZEDPSTACK_ROOT);
  }
  return path.resolve(__dirname, '..');
}

/** Ruta absoluta al entrypoint CLI (válida con symlink en ~/.agents/skills). */
export function dispatchScriptPath() {
  return path.join(zedpstackRoot(), 'scripts', 'dispatch.mjs');
}

export function mcpScriptPath() {
  return path.join(zedpstackRoot(), 'scripts', 'mcp.mjs');
}

export function runDir(repoRoot, runId) {
  return path.join(repoRoot, '.zedpstack', 'runs', runId);
}

export function workerDir(runRoot, stepId) {
  return path.join(runRoot, 'workers', stepId);
}
