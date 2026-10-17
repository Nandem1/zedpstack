import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReadyStepIds } from '../src/run.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadPlaybookDef(playbookId) {
  const p = path.join(repoRoot, 'playbooks', playbookId, 'playbook.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pendingManifest(stepIds) {
  return {
    steps: stepIds.map((stepId) => ({
      stepId,
      status: 'pending',
    })),
  };
}

function simulateWaves(playbookDef, manifest) {
  const waves = [];
  let state = structuredClone(manifest);
  while (true) {
    const ready = computeReadyStepIds(state, playbookDef);
    if (ready.length === 0) break;
    waves.push(ready);
    for (const stepId of ready) {
      const rec = state.steps.find((s) => s.stepId === stepId);
      rec.status = 'completed';
    }
  }
  return waves;
}

describe('run wave grouping (computeReadyStepIds)', () => {
  it('interrogate-review: 3 reviewers en paralelo, luego synthesize', () => {
    const def = loadPlaybookDef('interrogate-review');
    const manifest = pendingManifest(def.steps.map((s) => s.id));
    const waves = simulateWaves(def, manifest);
    assert.deepEqual(waves, [
      ['review-a', 'review-b', 'review-c'],
      ['synthesize'],
    ]);
  });

  it('architect-sketch: ground, luego 2 sketches, luego synthesize', () => {
    const def = loadPlaybookDef('architect-sketch');
    const manifest = pendingManifest(def.steps.map((s) => s.id));
    const waves = simulateWaves(def, manifest);
    assert.deepEqual(waves, [['ground'], ['sketch-a', 'sketch-b'], ['synthesize']]);
  });

  it('sin pasos pending no devuelve ready', () => {
    const def = loadPlaybookDef('interrogate-review');
    const manifest = {
      steps: def.steps.map((s) => ({ stepId: s.id, status: 'completed' })),
    };
    assert.deepEqual(computeReadyStepIds(manifest, def), []);
  });

  it('respeta inputFrom: synthesize no está ready hasta que reviewers completan', () => {
    const def = loadPlaybookDef('interrogate-review');
    const manifest = {
      steps: [
        { stepId: 'review-a', status: 'completed' },
        { stepId: 'review-b', status: 'pending' },
        { stepId: 'review-c', status: 'pending' },
        { stepId: 'synthesize', status: 'pending' },
      ],
    };
    const ready = computeReadyStepIds(manifest, def);
    assert.deepEqual(ready, ['review-b', 'review-c']);
    assert.ok(!ready.includes('synthesize'));
  });
});
