import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifestAtomic } from '../src/manifest.mjs';

describe('manifest atomic write', () => {
  it('writes readable manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-'));
    const m = { schemaVersion: 1, runId: 'r1', status: 'running', steps: [] };
    writeManifestAtomic(dir, m);
    const read = readManifest(dir);
    assert.equal(read.runId, 'r1');
  });
});
