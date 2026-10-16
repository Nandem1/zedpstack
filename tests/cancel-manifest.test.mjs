import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cancelRun } from '../src/cancel.mjs';
import { createInitialManifest, writeManifestAtomic } from '../src/manifest.mjs';
import { runDir } from '../src/paths.mjs';

describe('cancelRun', () => {
  it('marks manifest cancelled', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cancel-'));
    const runId = 'test-run';
    const runRoot = runDir(repoRoot, runId);
    fs.mkdirSync(runRoot, { recursive: true });
    const manifest = createInitialManifest({
      runId,
      repoRoot,
      gitCommit: null,
      playbook: 'architecture-review',
      goal: 'g',
      bindings: {},
      steps: [{ stepId: 'explore', role: 'explorer', status: 'running', attempts: [] }],
    });
    writeManifestAtomic(runRoot, manifest);
    const { manifest: out } = cancelRun({ repoRoot, runId });
    assert.equal(out.status, 'cancelled');
  });
});
