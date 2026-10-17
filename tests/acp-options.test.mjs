import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  childOptionState,
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

  it('derives each legacy option and preserves parameterized model IDs and descriptions', () => {
    const modelId = 'grok-4.6[effort=high,fast=true]';
    const models = { currentModelId: modelId, availableModels: [{ modelId, name: 'Grok' }] };
    const modes = {
      currentModeId: 'agent',
      availableModes: [{ id: 'agent', name: 'Agent', description: 'Make changes' }],
    };
    assert.deepEqual(childOptionState({ models }), {
      configOptions: [{
        id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelId,
        options: [{ value: modelId, name: 'Grok' }],
      }],
      legacyRoutes: { model: { method: 'session/set_model', valueKey: 'modelId' } },
    });
    assert.deepEqual(childOptionState({ modes }), {
      configOptions: [{
        id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent', description: 'Make changes' }],
      }],
      legacyRoutes: { mode: { method: 'session/set_mode', valueKey: 'modeId' } },
    });
  });

  it('keeps native options authoritative even when empty and legacy fields are present', () => {
    for (const configOptions of [[], [{ id: 'model', currentValue: 'native' }]]) {
      assert.deepEqual(childOptionState({
        configOptions,
        models: { currentModelId: 'legacy', availableModels: [] },
        modes: { currentModeId: 'legacy', availableModes: [] },
      }), { configOptions, legacyRoutes: {} });
    }
  });

  it('mergeCommands adds hub commands', () => {
    assert.deepEqual(mergeCommands([]).map((c) => c.name), ['claude', 'codex', 'cursor', 'board']);
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
    assert.deepEqual(merged.map((c) => c.name), ['claude', 'codex', 'cursor', 'board', 'help', 'compact']);
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
