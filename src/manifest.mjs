import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_SCHEMA_VERSION, ZEDPSTACK_VERSION } from './constants.mjs';

export function writeManifestAtomic(runRoot, manifest) {
  const target = path.join(runRoot, 'manifest.json');
  const tmp = `${target}.tmp`;
  const body = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, target);
}

export function readManifest(runRoot) {
  const target = path.join(runRoot, 'manifest.json');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

export function createInitialManifest({
  runId,
  repoRoot,
  gitCommit,
  playbook,
  goal,
  bindings,
  steps,
}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    repoRoot,
    gitCommit,
    playbook,
    goal,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    zedpstackVersion: ZEDPSTACK_VERSION,
    upstream: {
      pstackReference: 'pstack-claude@0.9.67',
      note: 'documentation only; not a runtime dependency',
    },
    bindings,
    steps,
  };
}

export function updateManifestStep(manifest, stepId, patch) {
  const steps = manifest.steps.map((s) => {
    if (s.stepId !== stepId) return s;
    const next = { ...s, ...patch };
    if (patch.lastErrors === null) {
      delete next.lastErrors;
    }
    return next;
  });
  return {
    ...manifest,
    steps,
    updatedAt: new Date().toISOString(),
  };
}
