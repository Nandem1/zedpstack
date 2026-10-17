import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityParser, narrationLine } from '../src/runtimes/activity.mjs';

function collect(runtime) {
  const seen = { activity: [], meta: [] };
  const parser = createActivityParser(runtime, {
    onActivity: (l) => seen.activity.push(l),
    onMeta: (m) => seen.meta.push(m.effectiveModel),
  });
  return { parser, seen };
}

describe('worker activity', () => {
  it('claude: effective model from init, tools and narration', () => {
    const { parser, seen } = collect('claude');
    parser.stdoutLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }));
    parser.stdoutLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reviso el UPDATE primero. Luego el resto.' }] } }));
    parser.stdoutLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/src/models/tracking.js' } }] } }));
    assert.deepEqual(seen.meta, ['claude-opus-4-8']);
    assert.deepEqual(seen.activity, ['· Reviso el UPDATE primero.', '> Inspecting src/models/tracking.js']);
  });

  it('cursor: thinking deltas become one narration line per thought', () => {
    const { parser, seen } = collect('cursor');
    for (const text of ['Voy a ', 'leer el modelo.']) parser.stdoutLine(JSON.stringify({ type: 'thinking', subtype: 'delta', text }));
    parser.stdoutLine(JSON.stringify({ type: 'thinking', subtype: 'completed' }));
    parser.stdoutLine(JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { grepToolCall: { args: { pattern: 'estado' } } } }));
    assert.deepEqual(seen.activity, ['· Voy a leer el modelo.', '> Searching for "estado"']);
  });

  it('codex: model header, narration and commands from stderr, across chunk splits', () => {
    const { parser, seen } = collect('codex');
    parser.stderrChunk('model: gpt-6.1-sol\nprovider: openai\ncodex\nLeo el diff');
    parser.stderrChunk(' y comparo.\nexec\n/bin/zsh -lc \'rg -n estado src\' in /repo\nsucceeded in 3ms:\n');
    assert.deepEqual(seen.meta, ['gpt-6.1-sol']);
    assert.deepEqual(seen.activity, ['· Leo el diff y comparo.', "> Running rg -n estado src"]);
  });

  it('narration is clipped to one line', () => {
    assert.equal(narrationLine('a'.repeat(200)).length, 2 + 96);
  });
});
