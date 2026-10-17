import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReadyStepIds } from '../src/run.mjs';
import { resolveRunPlaybook } from '../src/playbook.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadPlaybookDef(playbookId, roles = {}) {
  const p = path.join(repoRoot, 'playbooks', playbookId, 'playbook.json');
  return resolveRunPlaybook(JSON.parse(fs.readFileSync(p, 'utf8')), { config: { data: { roles } } });
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

  it('architect-sketch runs three candidates together and waits for c before synthesis', () => {
    const def = loadPlaybookDef('architect-sketch', { 'architect-runner-c': {} });
    const manifest = pendingManifest(def.steps.map((s) => s.id));
    assert.deepEqual(simulateWaves(def, manifest), [
      ['ground'], ['sketch-a', 'sketch-b', 'sketch-c'], ['synthesize'],
    ]);
    for (const step of manifest.steps) {
      if (['ground', 'sketch-a', 'sketch-b'].includes(step.stepId)) step.status = 'completed';
    }
    assert.deepEqual(computeReadyStepIds(manifest, def), ['sketch-c']);
  });

  it('architect-sketch retains two runners for generic-only and single-slot configurations', () => {
    for (const roles of [{ explorer: {} }, { 'architect-runner': {} }, { 'architect-runner-a': {} }]) {
      const def = loadPlaybookDef('architect-sketch', roles);
      assert.deepEqual(def.steps.map((step) => step.id), ['ground', 'sketch-a', 'sketch-b', 'synthesize']);
      assert.deepEqual(def.steps.at(-1).inputFrom, ['sketch-a', 'sketch-b', 'ground']);
    }
  });

  it('optional selection ignores inherited bindings and preserves unknown dependencies', () => {
    const def = {
      steps: [
        { id: 'optional', role: 'own-role', requiresExplicitBinding: true },
        { id: 'required', inputFrom: ['optional', 'unknown'] },
      ],
    };
    const roles = Object.create({ 'own-role': {} });
    const selected = resolveRunPlaybook(def, { config: { data: { roles } } });
    assert.deepEqual(selected.steps.map((step) => step.id), ['required']);
    assert.deepEqual(selected.steps[0].inputFrom, ['unknown']);
    assert.deepEqual(def.steps[1].inputFrom, ['optional', 'unknown']);
    assert.deepEqual(computeReadyStepIds(pendingManifest(['required']), selected), []);
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
