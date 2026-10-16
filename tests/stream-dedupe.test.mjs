import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaudeStreamText } from '../src/runtimes/stream.mjs';

describe('claude stream dedupe', () => {
  it('prefers terminal result event over assistant chunks', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world repeated' }] },
    });
    const terminal = JSON.stringify({
      type: 'result',
      result: 'Hello world repeated',
    });
    const a = extractClaudeStreamText(assistant);
    const t = extractClaudeStreamText(terminal);
    assert.equal(a.chunk, 'Hello world repeated');
    assert.equal(t.terminalResult, 'Hello world repeated');
  });
});
