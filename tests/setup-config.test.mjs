import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyModelSheetToConfig } from '../src/setupConfig.mjs';

describe('setupConfig', () => {
  it('applyModelSheetToConfig surfaces panel overflow and dropped sheet lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedpstack-setup-'));
    const sheetPath = path.join(tmp, 'pstack-models.md');
    const configPath = path.join(tmp, 'zedpstack.config.json');

    fs.writeFileSync(
      sheetPath,
      `architect runners: opus, fable, sonnet
line without colon is dropped
how explorer: haiku
`,
      'utf8',
    );

    const result = applyModelSheetToConfig({ sheetPath, configPath });

    assert.deepEqual(result.droppedLines, ['line without colon is dropped']);
    assert.equal(result.overflows.length, 1);
    assert.equal(result.overflows[0].model, 'sonnet');
    assert.equal(result.overflowWarnings.length, 1);
    assert.equal(result.rolesUpdated.includes('architect-runner-a'), true);
    assert.equal(result.rolesUpdated.includes('architect-runner-b'), true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.roles['architect-runner-b'].model, 'fable');
  });
});
