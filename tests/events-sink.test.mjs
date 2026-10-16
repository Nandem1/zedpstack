import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventSink } from '../src/events/sink.mjs';

describe('EventSink stream filtering', () => {
  it('does not persist worker.output by default', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-events-'));
    const sink = new EventSink(runRoot);
    sink.emit('run.started', { runId: 'r1' });
    sink.emit('worker.output', { chunk: 'noise' });
    const lines = fs.readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run\.started/);
  });

  it('persists worker.output when persistWorkerStream is true', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-events-'));
    const sink = new EventSink(runRoot, { persistWorkerStream: true });
    sink.emit('worker.output', { chunk: 'x' });
    const lines = fs.readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  });
});
