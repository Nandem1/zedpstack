import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingsFromSheet,
  inferRuntimeForModel,
  parseModelSheet,
  parseModelValue,
  rolesAffectedBySheet,
  sheetBindingOverflowWarnings,
  zedpstackManagedRoles,
} from '../src/modelSheet.mjs';

describe('modelSheet', () => {
  it('parses effort suffix', () => {
    assert.deepEqual(parseModelValue('opus @high'), { model: 'opus', effort: 'high' });
  });

  it('maps sheet to zedpstack bindings', () => {
    const parsed = parseModelSheet(`
how explorer: haiku
how explainer: gpt-6.1-sol
interrogate reviewers: haiku, gpt-6.1-sol, haiku
default effort: session
`);
    const { bindings } = bindingsFromSheet(parsed);
    assert.equal(bindings['how-explorer'].runtime, 'claude');
    assert.equal(bindings['how-explainer'].runtime, 'codex');
    assert.equal(bindings['interrogate-reviewer-b'].model, 'gpt-6.1-sol');
  });

  it('infers codex for gpt slugs', () => {
    assert.equal(inferRuntimeForModel('gpt-6.1-sol'), 'codex');
    assert.equal(inferRuntimeForModel('haiku'), 'claude');
  });

  it('parseModelSheet records lines without a role separator as dropped', () => {
    const parsed = parseModelSheet(`
how explorer: haiku
this line has no colon
# comment ignored
---
orphan value
reflect judgment: opus
`);
    assert.deepEqual(parsed.droppedLines, [
      'this line has no colon',
      'orphan value',
    ]);
    assert.equal(parsed.roles['how explorer']?.[0], 'haiku');
    assert.equal(parsed.roles['reflect judgment']?.[0], 'opus');
  });

  it('canonical reflect line with one model binds judgment, divergent, and synthesize', () => {
    const parsed = parseModelSheet(
      'reflect judgment, divergent, synthesizer: cursor-grok-4.6-high\n',
    );
    const { bindings, overflows } = bindingsFromSheet(parsed);
    assert.equal(overflows.length, 0);
    assert.equal(bindings['reflect-reviewer-judgment'].model, 'cursor-grok-4.6-high');
    assert.equal(bindings['reflect-reviewer-judgment'].runtime, 'cursor');
    assert.equal(bindings['reflect-reviewer-divergent'].model, 'cursor-grok-4.6-high');
    assert.equal(bindings['reflect-synthesize'].model, 'cursor-grok-4.6-high');
  });

  it('records skipped inheritance and roles affected for inherit-parent', () => {
    const parsed = parseModelSheet(`
how explorer: inherit-parent
architect runners: haiku, auto
`);
    const { bindings, rolesAffected, skippedInheritance } = bindingsFromSheet(parsed);
    assert.equal(Object.keys(bindings).length, 1);
    assert.equal(bindings['architect-runner-a'].model, 'haiku');
    assert.equal(rolesAffected.includes('how-explorer'), true);
    assert.equal(rolesAffected.includes('explorer'), true);
    assert.equal(rolesAffected.includes('architect-runner-b'), true);
    assert.equal(
      skippedInheritance.some(
        (e) => e.sheetRole === 'how explorer' && e.zedRole === 'how-explorer',
      ),
      true,
    );
    assert.equal(
      skippedInheritance.some(
        (e) => e.sheetRole === 'architect runners' && e.zedRole === 'architect-runner-b',
      ),
      true,
    );
    assert.deepEqual(rolesAffectedBySheet(parsed), rolesAffected);
  });

  it('zedpstackManagedRoles lists every mapped worker id', () => {
    const managed = zedpstackManagedRoles();
    assert.equal(managed.includes('how-explorer'), true);
    assert.equal(managed.includes('interrogate-reviewer-c'), true);
    assert.equal(managed.includes('explorer'), true);
  });

  it('architect runners overflow reports extra models without overwriting slot b', () => {
    const parsed = parseModelSheet('architect runners: opus, fable, sonnet\n');
    const { bindings, overflows } = bindingsFromSheet(parsed);
    assert.equal(bindings['architect-runner-a'].model, 'opus');
    assert.equal(bindings['architect-runner-b'].model, 'fable');
    assert.deepEqual(overflows, [
      { sheetRole: 'architect runners', model: 'sonnet', index: 2 },
    ]);
    const warnings = sheetBindingOverflowWarnings(overflows);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /architect runners/);
    assert.match(warnings[0], /sonnet/);
  });
});
