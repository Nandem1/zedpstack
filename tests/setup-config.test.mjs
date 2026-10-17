import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyModelSheetToConfig,
  reconcileConfigRoles,
} from '../src/setupConfig.mjs';
import { parseModelSheet, bindingsFromSheet } from '../src/modelSheet.mjs';

describe('setupConfig', () => {
  it('applyModelSheetToConfig surfaces panel overflow and dropped sheet lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');

    fs.writeFileSync(
      sheetPath,
      `architect runners: opus, fable, sonnet, haiku
line without colon is dropped
how explorer: haiku
`,
      'utf8',
    );

    const result = applyModelSheetToConfig({ sheetPath, configPath });

    assert.deepEqual(result.droppedLines, ['line without colon is dropped']);
    assert.equal(result.overflows.length, 1);
    assert.equal(result.overflows[0].model, 'haiku');
    assert.equal(result.overflowWarnings.length, 1);
    assert.equal(result.rolesUpdated.includes('architect-runner-a'), true);
    assert.equal(result.rolesUpdated.includes('architect-runner-b'), true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.roles['architect-runner-b'].model, 'fable');
  });

  it('applies a third architect model and removes it when the panel shrinks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');
    fs.writeFileSync(sheetPath, 'architect runners: gpt-6.1-sol, opus, cursor:grok-4.7-high\ndefault effort: high\n');

    const result = applyModelSheetToConfig({ sheetPath, configPath });
    assert.deepEqual(result.overflows, []);
    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.roles['architect-runner-c'], {
      runtime: 'cursor', model: 'grok-4.7-high', permissionProfile: 'read-only', effort: 'high',
    });
    assert.equal(config.roles['architect-runner-a'].effort, 'high');
    assert.equal(config.roles['architect-runner-b'].effort, 'high');

    fs.writeFileSync(sheetPath, 'architect runners: gpt-6.1-sol, opus\n');
    const shortened = applyModelSheetToConfig({ sheetPath, configPath });
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(shortened.rolesRemoved.includes('architect-runner-c'));
    assert.equal(config.roles['architect-runner-c'], undefined);
    assert.equal(config.roles['architect-runner-b'].model, 'opus');
  });

  it('inherit-parent clears prior bindings for affected sheet roles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        roles: {
          'how-explorer': { runtime: 'claude', model: 'old-opus', permissionProfile: 'read-only' },
          explorer: { runtime: 'claude', model: 'old-opus', permissionProfile: 'read-only' },
          'custom-role': { runtime: 'claude', model: 'keep-me', permissionProfile: 'read-only' },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(sheetPath, 'how explorer: inherit-parent\n', 'utf8');

    const result = applyModelSheetToConfig({ sheetPath, configPath });

    assert.equal(result.skippedInheritance.length, 2);
    assert.equal(result.rolesUpdated.includes('how-explorer'), false);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.roles['how-explorer'], undefined);
    assert.equal(config.roles.explorer, undefined);
    assert.equal(config.roles['custom-role'].model, 'keep-me');
  });

  it('removes zedpstack-managed roles when sheet rows disappear', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        roles: {
          'architect-runner-a': {
            runtime: 'codex',
            model: 'stale',
            permissionProfile: 'read-only',
          },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(sheetPath, 'how explorer: haiku\n', 'utf8');

    applyModelSheetToConfig({ sheetPath, configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.roles['architect-runner-a'], undefined);
    assert.equal(config.roles['how-explorer'].model, 'haiku');
  });

  it('panel reconcile drops a slot when the sheet lists one model', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        roles: {
          'architect-runner-a': { runtime: 'claude', model: 'opus', permissionProfile: 'read-only' },
          'architect-runner-b': { runtime: 'claude', model: 'fable', permissionProfile: 'read-only' },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(sheetPath, 'architect runners: opus\n', 'utf8');

    applyModelSheetToConfig({ sheetPath, configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.roles['architect-runner-a'].model, 'opus');
    assert.equal(config.roles['architect-runner-b'], undefined);
  });

  it('reconcileConfigRoles clears alias roles on inherit-parent rows', () => {
    const parsed = parseModelSheet('how explorer: inherit-parent\n');
    const { bindings, rolesAffected } = bindingsFromSheet(parsed);
    const roles = reconcileConfigRoles(
      {
        explorer: { runtime: 'claude', model: 'manual', permissionProfile: 'read-only' },
      },
      bindings,
      rolesAffected,
      parsed,
    );
    assert.equal(roles.explorer, undefined);
    assert.equal(roles['how-explorer'], undefined);
  });
});
