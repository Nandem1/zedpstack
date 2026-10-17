import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectHub, engineEnv, shortHome } from './helpers/acpHub.mjs';
import { childEnv } from './helpers/env.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const prompt = (ctx, sessionId, text) => ctx.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
const chunks = (ctx, sessionId) => ctx.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk').map((u) => u.update.content.text);
const rejectOptions = [
  { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
  { optionId: 'never', kind: 'reject_always', name: 'Reject always' },
  { optionId: 'no', kind: 'reject_once', name: 'Reject' },
];

async function setup(t) {
  const sb = makeSandbox();
  const modes = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'agent', 'ask'];
  const env = childEnv(engineEnv({
    ZEDPSTACK_HOME: shortHome('zp-internal-'),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{
      id: 'mode', name: 'Mode', type: 'select', currentValue: 'default',
      options: modes.map((value) => ({ value, name: value })),
    }]),
  }));
  const ctx = connectHub(t, env);
  const { sessionId } = await ctx.rpc('session/new', { cwd: sb.repo });
  const permission = async (request) => {
    const before = chunks(ctx, sessionId).length;
    await prompt(ctx, sessionId, `PERMISSION ${JSON.stringify(request)}`);
    return JSON.parse(chunks(ctx, sessionId).slice(before).find((text) => text.startsWith('permission:')).slice('permission:'.length));
  };
  return { ...ctx, ctx, sb, sessionId, permission };
}

describe('ACP internal edit tools', () => {
  for (const kind of ['edit', 'delete', 'move']) {
    it(`rejects ${kind} locally once per call while off and forwards unchanged while on`, async (t) => {
      const { ctx, sb, sessionId, permission } = await setup(t);
      const request = { toolCall: { toolCallId: 'internal-1', kind, locations: [{ path: path.join(sb.repo, 'yo.txt') }] }, options: rejectOptions };
      assert.deepEqual(await permission({ ...request, repeat: 2 }), [
        { outcome: { outcome: 'selected', optionId: 'no' } }, { outcome: { outcome: 'selected', optionId: 'no' } },
      ]);
      assert.equal(ctx.clientRequests.length, 0);
      assert.equal(chunks(ctx, sessionId).filter((text) => text === 'El orquestador no edita archivos: delega con spawn_agent (o /edits on)').length, 1);
      const audit = fs.readFileSync(path.join(sb.repo, '.zedpstack/orchestrator-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(audit.length, 1);
      assert.deepEqual({ tool: audit[0].tool, path: audit[0].path }, { tool: 'session/request_permission', path: 'yo.txt' });
      assert.ok(Number.isFinite(Date.parse(audit[0].ts)));
      await prompt(ctx, sessionId, '/edits on');
      assert.deepEqual(await permission(request), [{ outcome: { outcome: 'selected', optionId: 'ok' } }]);
      assert.deepEqual(ctx.clientRequests[0], { method: 'session/request_permission', params: { sessionId, ...request } });
    });
  }

  it('selects reject_always when needed, cancels without a reject, and checks execute commands with the shared guard', async (t) => {
    const { ctx, sessionId, permission } = await setup(t);
    assert.deepEqual(await permission({ toolCall: { toolCallId: 'a', kind: 'edit' }, options: [rejectOptions[1]] }), [{ outcome: { outcome: 'selected', optionId: 'never' } }]);
    assert.deepEqual(await permission({ toolCall: { toolCallId: 'b', kind: 'move' }, options: [rejectOptions[0]] }), [{ outcome: { outcome: 'cancelled' } }]);
    const execute = (id, command) => ({ toolCall: { toolCallId: id, kind: 'execute', rawInput: { command } }, options: rejectOptions });
    assert.deepEqual(await permission(execute('c', 'echo hi > yo.txt')), [{ outcome: { outcome: 'selected', optionId: 'no' } }]);
    assert.deepEqual(await permission(execute('d', 'git diff --stat')), [{ outcome: { outcome: 'selected', optionId: 'ok' } }]);
    assert.equal(ctx.clientRequests.length, 1);
    assert.equal(ctx.clientRequests[0].params.sessionId, sessionId);
    assert.equal(ctx.clientRequests[0].params.toolCall.rawInput.command, 'git diff --stat');
  });

  it('merges partial edit updates and warns/audits once, excluding outside, internal and worker paths', async (t) => {
    const { ctx, sb, sessionId, permission } = await setup(t);
    await permission({ toolCall: { toolCallId: 'denied', kind: 'edit' }, options: rejectOptions });
    const changes = [
      { sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', locations: [{ path: 'src/new.txt' }] },
      ...Array.from({ length: 3 }, () => ({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed', content: [{ type: 'diff', path: 'src/new.txt', oldText: '', newText: 'hi' }] })),
      { sessionUpdate: 'tool_call', toolCallId: 'edit-2', kind: 'move' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'edit-2', content: [{ type: 'diff', path: 'moved.txt', oldText: '', newText: 'hi' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'edit-3', kind: 'delete' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'edit-3', kind: null, content: null, locations: [{ path: 'deleted.txt' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'outside', kind: 'delete', locations: [{ path: path.join(sb.root, 'out.txt') }] },
      { sessionUpdate: 'tool_call', toolCallId: 'internal', kind: 'edit', locations: [{ path: '.zedpstack/log.txt' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'zp-worker', kind: 'edit', locations: [{ path: 'worker.txt' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'denied', locations: [{ path: 'denied.txt' }] },
    ];
    await prompt(ctx, sessionId, `UPDATES ${JSON.stringify(changes)}`);
    const warnings = chunks(ctx, sessionId).filter((text) => text.startsWith('⚠ El orquestador editó'));
    assert.deepEqual(warnings, ['src/new.txt', 'moved.txt', 'deleted.txt'].map((target) => `⚠ El orquestador editó ${target} directamente (el motor no pidió permiso). Revisa con git diff; usa /edits on si fue intencional.`));
    const toolUpdates = ctx.updates.filter((u) => ['tool_call', 'tool_call_update'].includes(u.update.sessionUpdate));
    assert.deepEqual(toolUpdates.map((u) => u.update), changes);
    assert.ok(toolUpdates.every((u) => u.sessionId === sessionId));
    const audit = fs.readFileSync(path.join(sb.repo, '.zedpstack/orchestrator-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(audit.map((line) => line.path), ['(herramienta interna)', 'src/new.txt', 'moved.txt', 'deleted.txt']);
    await prompt(ctx, sessionId, '/edits on');
    await prompt(ctx, sessionId, `UPDATES ${JSON.stringify([{ sessionUpdate: 'tool_call', toolCallId: 'allowed', kind: 'edit', locations: [{ path: 'allowed.txt' }] }])}`);
    assert.equal(chunks(ctx, sessionId).filter((text) => text.startsWith('⚠')).length, 3);
    await prompt(ctx, sessionId, '/claude');
    await prompt(ctx, sessionId, '/edits off');
    await prompt(ctx, sessionId, `UPDATES ${JSON.stringify([changes[0]])}`);
    assert.equal(chunks(ctx, sessionId).filter((text) => text.startsWith('⚠')).length, 4, 'a fresh engine may reuse tool ids');
  });

  for (const [runtime, mode, level] of [
    ['claude', 'default', 'bloquea'], ['claude', 'plan', 'bloquea'], ['claude', 'acceptEdits', 'solo avisa'],
    ['claude', 'bypassPermissions', 'solo avisa'], ['cursor', 'ask', 'bloquea'], ['cursor', 'plan', 'bloquea'],
    ['cursor', 'agent', 'solo avisa'], ['codex', 'default', 'solo avisa'],
  ]) {
    it(`/edits reports ${runtime} ${mode} as ${level} without changing the engine mode`, async (t) => {
      const { ctx, sessionId } = await setup(t);
      await prompt(ctx, sessionId, `/${runtime}`);
      await ctx.rpc('session/set_config_option', { sessionId, configId: 'mode', value: mode });
      for (const command of ['/edits', '/edits on', '/edits off']) {
        await prompt(ctx, sessionId, command);
        const status = chunks(ctx, sessionId).at(-1);
        assert.match(status, new RegExp(`editsAllowed=${command === '/edits on'}`));
        assert.match(status, new RegExp(`Motor ${runtime}, modo ${mode}\\. Con /edits off, ${level}\\.`));
        assert.match(status, /dispatch install/);
      }
    });
  }
});
