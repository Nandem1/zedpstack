import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventSink } from '../src/events/sink.mjs';
import { readProgressLog } from '../src/progressLog.mjs';

describe('progressLog', () => {
  it('writes human lines to progress.log on emit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zedp-progress-'));
    const sink = new EventSink(tmp);
    sink.emit('worker.spawned', {
      runtime: 'claude',
      model: 'haiku',
      role: 'how-explorer',
    });
    const logPath = path.join(tmp, 'progress.log');
    assert.match(fs.readFileSync(logPath, 'utf8'), /Claude explorer — running/);
    const { text } = readProgressLog(tmp, 0);
    assert.match(text, /running/);
  });
});
