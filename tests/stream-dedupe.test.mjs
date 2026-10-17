import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractStreamText } from '../src/runtimes/stream.mjs';

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
    const a = extractStreamText(assistant);
    const t = extractStreamText(terminal);
    assert.equal(a.chunk, 'Hello world repeated');
    assert.equal(t.terminalResult, 'Hello world repeated');
  });
});
