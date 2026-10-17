import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkerModels, resolveAgentModel } from '../src/workerModels.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

describe('worker model resolution', () => {
  let models;
  before(() => {
    const sb = makeSandbox({
      sheet: [
        'how explorer: haiku @low',
        'architect runners: gpt-6.1-sol, cursor:claude-opus-5-5, inherit-parent',
        'reflect judgment, divergent, synthesizer: sonnet',
        'default effort: high',
      ].join('\n'),
    });
    models = loadWorkerModels({ sheetPath: sb.sheetPath });
  });

  it('reads a sheet row with its own effort', () => {
    const r = resolveAgentModel({ role: 'how explorer' }, models);
    assert.deepEqual([r.runtime, r.model, r.effort, r.source], ['claude', 'haiku', 'low', 'sheet:how explorer']);
  });

  it('picks panel slots and honours runtime prefixes', () => {
    const a = resolveAgentModel({ role: 'architect runners', slot: 0 }, models);
    const b = resolveAgentModel({ role: 'architect runners', slot: 1 }, models);
    assert.deepEqual([a.runtime, a.model, a.effort], ['codex', 'gpt-6.1-sol', 'high']);
    assert.deepEqual([b.runtime, b.model], ['cursor', 'claude-opus-5-5']);
  });

  it('falls back to the pstack default for inherit-parent and says so', () => {
    const r = resolveAgentModel({ role: 'architect runners', slot: 2 }, models);
    assert.equal(r.model, 'opus');
    assert.match(r.notes[0], /cannot inherit/);
  });

  it('rejects an out-of-range slot and an unknown role', () => {
    assert.throws(() => resolveAgentModel({ role: 'architect runners', slot: 3 }, models), /3 slot/);
    assert.throws(() => resolveAgentModel({ role: 'nope' }, models), /unknown role "nope"/);
  });

  it('answers a split name of a combined row', () => {
    assert.equal(resolveAgentModel({ role: 'reflect divergent' }, models).model, 'sonnet');
  });

  it('uses pstack models.json for rows the sheet lacks', () => {
    const r = resolveAgentModel({ role: 'bug-fix' }, models);
    assert.deepEqual([r.model, r.source], ['fable', 'pstack-default:bug-fix']);
  });

  it('explicit model wins, and a forced runtime mismatch is noted', () => {
    const r = resolveAgentModel({ role: 'how explorer', model: 'composer-2.5', runtime: 'claude' }, models);
    assert.equal(r.runtime, 'claude');
    assert.match(r.notes[0], /belongs on runtime "cursor"/);
  });
});
