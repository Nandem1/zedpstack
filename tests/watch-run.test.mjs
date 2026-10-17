import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatEvent,
  isTerminalRunEvent,
  shouldDisplayEvent,
  watchRun,
} from '../src/watchRun.mjs';
import { runDir } from '../src/paths.mjs';

function writeEvent(eventsPath, type, extra = {}) {
  const line = `${JSON.stringify({
    ts: '2026-01-01T00:00:00.000Z',
    type,
    ...extra,
  })}\n`;
  fs.appendFileSync(eventsPath, line);
}

function setupRunEvents(repoRoot, runId, initialLines = '') {
  const runRoot = runDir(repoRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const eventsPath = path.join(runRoot, 'events.jsonl');
  fs.writeFileSync(eventsPath, initialLines);
  return eventsPath;
}

describe('watchRun helpers', () => {
  it('shouldDisplayEvent matches run.mjs worker terminal types', () => {
    assert.equal(shouldDisplayEvent('run.awaiting_judgment'), true);
    assert.equal(shouldDisplayEvent('worker.completed'), true);
    assert.equal(shouldDisplayEvent('worker.failed'), true);
    assert.equal(shouldDisplayEvent('judgment.awaiting'), false);
    assert.equal(shouldDisplayEvent('worker.finished'), false);
  });

  it('isTerminalRunEvent covers completed, failed, cancelled', () => {
    assert.equal(isTerminalRunEvent('run.completed'), true);
    assert.equal(isTerminalRunEvent('run.failed'), true);
    assert.equal(isTerminalRunEvent('run.cancelled'), true);
    assert.equal(isTerminalRunEvent('run.awaiting_judgment'), false);
  });

  it('formatEvent previews stderr chunks', () => {
    const line = formatEvent({
      ts: 't',
      type: 'worker.stderr',
      chunk: 'warn one\nwarn two',
    });
    assert.match(line, /worker\.stderr/);
    assert.match(line, /\| warn one warn two/);
  });
});

describe('watchRun', () => {
  it('throws when events.jsonl is missing', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-watch-'));
    await assert.rejects(
      () => watchRun({ repoRoot, runId: 'missing', follow: false }),
      /No events/,
    );
  });

  it('with fromStart prints human events and exits follow on run.completed', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-watch-'));
    const runId = 'done-run';
    const eventsPath = setupRunEvents(repoRoot, runId);
    writeEvent(eventsPath, 'run.started', { runId });
    writeEvent(eventsPath, 'worker.spawned', { stepId: 'explore', workerId: 'w1' });
    writeEvent(eventsPath, 'worker.completed', { stepId: 'explore', workerId: 'w1', exitCode: 0 });
    writeEvent(eventsPath, 'run.completed', { runId });

    const lines = [];
    const started = Date.now();
    await watchRun({
      repoRoot,
      runId,
      fromStart: true,
      follow: true,
      pollMs: 25,
      writeLine: (line) => lines.push(line),
    });
    assert.ok(Date.now() - started < 2000, 'should not hang after terminal event');
    const joined = lines.join('\n');
    assert.match(joined, /run\.started/);
    assert.match(joined, /worker\.completed/);
    assert.match(joined, /run\.completed/);
    assert.doesNotMatch(joined, /worker\.finished/);
  });

  it('tails new lines without losing bytes between polls', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-watch-'));
    const runId = 'tail-run';
    const eventsPath = setupRunEvents(repoRoot, runId);

    const lines = [];
    const watchPromise = watchRun({
      repoRoot,
      runId,
      fromStart: false,
      follow: true,
      pollMs: 30,
      writeLine: (line) => lines.push(line),
    });

    writeEvent(eventsPath, 'run.started', { runId });
    writeEvent(eventsPath, 'run.awaiting_judgment', { runId });

    await new Promise((r) => setTimeout(r, 120));
    writeEvent(eventsPath, 'run.completed', { runId });

    await watchPromise;
    const joined = lines.join('\n');
    assert.match(joined, /run\.started/);
    assert.match(joined, /run\.awaiting_judgment/);
    assert.match(joined, /run\.completed/);
  });

  it('follow=false only replays when fromStart', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-watch-'));
    const runId = 'noreplay';
    const eventsPath = setupRunEvents(repoRoot, runId);
    writeEvent(eventsPath, 'run.failed', { runId });

    const lines = [];
    await watchRun({
      repoRoot,
      runId,
      fromStart: false,
      follow: false,
      writeLine: (line) => lines.push(line),
    });
    assert.equal(lines.length, 0);

    lines.length = 0;
    await watchRun({
      repoRoot,
      runId,
      fromStart: true,
      follow: false,
      writeLine: (line) => lines.push(line),
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run\.failed/);
  });
});
