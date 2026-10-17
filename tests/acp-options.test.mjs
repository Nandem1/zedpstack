import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPrefs,
  mergeCommands,
  mergeOptions,
  routeOption,
  runtimeOption,
  savePrefs,
  ZP_RUNTIME_ID,
} from '../src/acp/options.mjs';

describe('acp options', () => {
  it('runtimeOption and mergeOptions', () => {
    const zp = runtimeOption('claude');
    assert.equal(zp.id, ZP_RUNTIME_ID);
    const merged = mergeOptions(zp, [{ id: 'model', name: 'M', type: 'select', currentValue: 'a', options: [] }]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, ZP_RUNTIME_ID);
  });

  it('routeOption', () => {
    assert.equal(routeOption(ZP_RUNTIME_ID), 'hub');
    assert.equal(routeOption('model'), 'child');
  });

  it('mergeCommands adds hub commands', () => {
    const cmds = mergeCommands([]);
    assert.ok(cmds.some((c) => c.name === 'claude'));
    assert.ok(cmds.some((c) => c.name === 'spawn'));
  });

  it('mergeCommands keeps hub commands first and authoritative, with unique names', () => {
    const hubCommands = mergeCommands([]);
    const help = { name: 'help', description: 'Child help', input: { hint: 'topic' } };
    const compact = { name: 'compact', description: 'Compact conversation' };
    const merged = mergeCommands([
      help,
      ...hubCommands.map((c) => ({ name: c.name, description: 'Child override' })),
      { name: 'help', description: 'Duplicate help' },
      compact,
    ]);
    assert.deepEqual(merged, [...hubCommands, help, compact]);
    assert.deepEqual(merged.map((c) => c.name), ['claude', 'codex', 'cursor', 'board', 'spawn', 'help', 'compact']);
  });

  it('loadPrefs and savePrefs use ZEDPSTACK_HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-acp-prefs-'));
    const env = { ZEDPSTACK_HOME: home };
    savePrefs({ lastRuntime: 'codex', perRuntime: { codex: { model: 'beta' } } }, env);
    const loaded = loadPrefs(env);
    assert.equal(loaded.lastRuntime, 'codex');
    assert.equal(loaded.perRuntime.codex.model, 'beta');
  });
});
