import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentDir, createSpec, writeRun } from '../src/agents/store.mjs';
import {
  THROTTLE_MS,
  STREAM_TOOL_KIND,
  createThrottleGate,
  createWorkerUpdateSink,
  workerTitle,
} from '../src/acp/updates.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

function contentText(update) {
  const block = update?.content?.[0];
  return block?.content?.text ?? '';
}

function seedCompletedAgent(repo, id = 'test-worker-abc') {
  const now = new Date().toISOString();
  createSpec(repo, {
    id,
    binding: { runtime: 'cursor', model: 'haiku', permissionProfile: 'read-only' },
    description: 'probe',
    role: 'how explorer',
    slot: 0,
    repoRoot: repo,
    cwd: repo,
    isolation: 'none',
    worktree: null,
    createdAt: now,
  });
  writeRun(repo, id, {
    runnerPid: null,
    workerPid: null,
    startedAt: now,
    effectiveModel: null,
    outcome: { ok: true, exitCode: 0, timedOut: false, error: null, changes: null, changeError: null, finishedAt: now },
  });
  return id;
}

describe('acp updates throttle', () => {
  it('bounds emissions over a burst', () => {
    const gate = createThrottleGate(THROTTLE_MS);
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < 1000) {
      attempts += 1;
      gate.tick();
    }
    gate.tick(true);
    assert.ok(attempts > 20, 'many attempts in 1s');
    assert.ok(gate.count <= Math.ceil(1000 / THROTTLE_MS) + 2, `count=${gate.count}`);
  });
});

describe('createWorkerUpdateSink (content mode)', () => {
  it('initial tool_call has placeholder content and streams in_progress before completed', async () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo);
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-test',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'content',
    });

    sink.emitStart();
    const startCall = updates.find((u) => u.sessionUpdate === 'tool_call');
    assert.equal(startCall?.kind, STREAM_TOOL_KIND.content);
    assert.ok(startCall?.content?.length, 'tool_call includes content');
    assert.match(contentText(startCall), /Iniciando worker/);

    sink.onFollowEvent({ type: 'status', status: 'running' });
    sink.onFollowEvent({ type: 'activity', line: 'línea de progreso humana' });
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 80));

    const progress = updates.filter(
      (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress',
    );
    assert.ok(progress.length >= 1, 'at least one in_progress update during run');
    const withBody = progress.filter((u) => contentText(u).includes('línea de progreso humana'));
    assert.ok(withBody.length >= 1, 'in_progress update carries streamed text');

    const idxFirstProgress = updates.findIndex(
      (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress',
    );
    await sink.finish();
    const idxCompleted = updates.findIndex(
      (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed',
    );
    assert.ok(idxFirstProgress >= 0 && idxFirstProgress < idxCompleted, 'in_progress before completed');
  });

  it('skips JSON-looking stdout lines in cumulative content', async () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo, 'test-worker-json');
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-json',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'content',
    });
    sink.emitStart();
    sink.onFollowEvent({ type: 'status', status: 'running' });
    sink.onFollowEvent({ type: 'activity', line: 'solo actividad' });
    sink.onFollowEvent({ type: 'output', text: '{"type":"assistant","message":{}}\n' });
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 80));

    const bodies = updates
      .filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress')
      .map((u) => contentText(u));
    assert.ok(bodies.some((t) => t.includes('solo actividad')));
    assert.ok(!bodies.some((t) => t.includes('"type":"assistant"')));
  });

  it('throttles tool_call_update emissions during activity bursts', async () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo, 'test-worker-throttle');
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-throttle',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'content',
    });
    sink.emitStart();
    sink.onFollowEvent({ type: 'status', status: 'running' });
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      sink.onFollowEvent({ type: 'activity', line: `tick ${Date.now()}` });
    }
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 80));
    const elapsed = Date.now() - t0;
    const progressOnly = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    const maxExpected = Math.ceil(elapsed / THROTTLE_MS) + 4;
    assert.ok(progressOnly.length <= maxExpected, `updates=${progressOnly.length} max=${maxExpected}`);
  });
});

describe('createWorkerUpdateSink (terminal mode)', () => {
  it('initial tool_call uses execute kind, in_progress, terminal content and cwd', () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo, 'test-worker-term-start');
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-term',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'terminal',
    });
    sink.emitStart();
    const startCall = updates.find((u) => u.sessionUpdate === 'tool_call');
    assert.equal(startCall?.kind, STREAM_TOOL_KIND.terminal);
    assert.equal(startCall?.status, 'in_progress');
    assert.deepEqual(startCall?.content, [{ type: 'terminal', terminalId: agentId }]);
    assert.equal(startCall?._meta?.terminal_info?.terminal_id, agentId);
    assert.equal(startCall?._meta?.terminal_info?.cwd, sb.repo);
    assert.equal(startCall?._meta?.tool_name, undefined);
  });

  it('progress updates omit content and stream incremental CRLF terminal_output', async () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo, 'test-worker-term-stream');
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-term-stream',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'terminal',
    });
    sink.emitStart();
    sink.onFollowEvent({ type: 'status', status: 'running' });
    sink.onFollowEvent({ type: 'activity', line: 'línea A' });
    sink.onFollowEvent({ type: 'activity', line: 'línea B' });
    sink.onFollowEvent({ type: 'output', text: '{"json":true}\n' });
    sink.onFollowEvent({ type: 'output', text: 'stdout humano\n' });
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 80));

    const progress = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    assert.ok(progress.length >= 1);
    for (const u of progress) {
      assert.equal(u.content, undefined);
      assert.equal(u._meta?.tool_name, undefined);
    }

    const outputs = progress
      .map((u) => u._meta?.terminal_output?.data)
      .filter(Boolean);
    assert.ok(outputs.length >= 1);
    const joined = outputs.join('');
    assert.match(joined, /línea A/);
    assert.match(joined, /stdout humano/);
    assert.ok(!joined.includes('"json":true'));
    assert.ok(joined.includes('\r\n'), 'terminal data uses CRLF');
    assert.equal(joined.split('línea A').length - 1, 1, 'incremental chunks do not repeat línea A');
  });

  it('finish emits terminal_exit and never content on updates', async () => {
    const sb = makeSandbox();
    const agentId = seedCompletedAgent(sb.repo, 'test-worker-term-finish');
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-term-finish',
      repo: sb.repo,
      agentId,
      title: 'worker',
      streamMode: 'terminal',
    });
    sink.emitStart();
    sink.onFollowEvent({ type: 'status', status: 'running' });
    await sink.finish();

    const afterStart = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    assert.ok(afterStart.every((u) => u.content === undefined));

    const exitUpdate = afterStart.find((u) => u._meta?.terminal_exit);
    assert.ok(exitUpdate, 'terminal_exit present');
    assert.equal(exitUpdate.status, 'completed');
    assert.equal(exitUpdate._meta.terminal_exit.terminal_id, agentId);
    assert.equal(exitUpdate._meta.terminal_exit.exit_code, 0);
  });
});

describe('worker card model check', () => {
  function seedModelRun(repo, id, { model, effectiveModel, expectedModel }) {
    const now = new Date().toISOString();
    createSpec(repo, {
      id,
      binding: { runtime: 'claude', model, permissionProfile: 'read-only' },
      description: 'Review plan',
      role: 'judgment and prose',
      repoRoot: repo,
      cwd: repo,
      isolation: 'none',
      worktree: null,
      createdAt: now,
      expectedModel,
    });
    writeRun(repo, id, {
      runnerPid: null,
      workerPid: null,
      startedAt: now,
      effectiveModel,
      outcome: { ok: true, exitCode: 0, timedOut: false, error: null, changes: null, changeError: null, finishedAt: now },
    });
    fs.writeFileSync(path.join(agentDir(repo, id), 'result.json'), JSON.stringify({ text: 'Respaldo con condiciones.' }));
    return id;
  }

  async function finishCard(repo, agentId) {
    const updates = [];
    const sink = createWorkerUpdateSink({
      notify: ({ update }) => updates.push(update),
      sessionId: 'sess-model',
      repo,
      agentId,
      title: workerTitle({ description: 'Review plan', model: 'opus', runtime: 'claude' }),
      streamMode: 'content',
    });
    sink.emitStart();
    await sink.finish();
    return updates.find((u) => u.status === 'completed');
  }

  it('a mismatch stays completed, retitles the card and leads its content with the warning', async () => {
    const sb = makeSandbox();
    const id = seedModelRun(sb.repo, 'card-mismatch', { model: 'opus', effectiveModel: 'claude-opus-4-8', expectedModel: 'claude-opus-5-5' });
    const done = await finishCard(sb.repo, id);
    assert.equal(done.title, 'Review plan · opus → claude-opus-4-8 ⚠ esperado claude-opus-5-5 (claude)');
    const text = contentText(done);
    assert.match(text.split('\n')[0], /^⚠ model mismatch: requested opus, the CLI ran claude-opus-4-8, expected claude-opus-5-5/);
    assert.match(text, /Respaldo con condiciones/);
  });

  it('an unprobed alias gets a neutral note', async () => {
    const sb = makeSandbox();
    const id = seedModelRun(sb.repo, 'card-alias', { model: 'opus', effectiveModel: 'claude-opus-4-8', expectedModel: null });
    const done = await finishCard(sb.repo, id);
    assert.equal(done.title, 'Review plan · opus → claude-opus-4-8 (alias) (claude)');
    assert.equal(contentText(done), 'Respaldo con condiciones.');
  });

  it('keeps the title when the model needs no label', async () => {
    const sb = makeSandbox();
    const id = seedModelRun(sb.repo, 'card-ok', { model: 'opus', effectiveModel: null, expectedModel: null });
    const done = await finishCard(sb.repo, id);
    assert.equal(done.title, undefined);
  });
});
