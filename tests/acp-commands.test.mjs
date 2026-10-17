import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptCommand } from '../src/acp/commands.mjs';

describe('acp commands', () => {
  it('parses single spawn', () => {
    const c = parsePromptCommand('/spawn how explorer :: Where is x?');
    assert.deepEqual(c, { type: 'spawn', count: 1, role: 'how explorer', prompt: 'Where is x?' });
  });

  it('parses parallel spawn', () => {
    const c = parsePromptCommand('/spawn x10 architect runners :: load test');
    assert.equal(c.type, 'spawn');
    assert.equal(c.count, 10);
    assert.equal(c.role, 'architect runners');
  });

  it('caps spawn count at 50', () => {
    const c = parsePromptCommand('/spawn x99 how explorer :: x');
    assert.equal(c.count, 50);
  });

  it('recognizes board', () => {
    assert.deepEqual(parsePromptCommand('/board'), { type: 'board' });
  });

  it('recognizes board and spawn without leading slash', () => {
    assert.deepEqual(parsePromptCommand('board'), { type: 'board' });
    const c = parsePromptCommand('spawn x2 how explorer :: trace y');
    assert.equal(c.type, 'spawn');
    assert.equal(c.count, 2);
    assert.equal(c.role, 'how explorer');
    assert.equal(c.prompt, 'trace y');
  });

  it('keeps multi-line prompt after :: on first line', () => {
    const text = 'spawn how explorer :: line one\nline two\n/board ignored';
    const c = parsePromptCommand(text);
    assert.equal(c.type, 'spawn');
    assert.equal(c.prompt, 'line one\nline two\n/board ignored');
  });

  it('returns usage for unknown input', () => {
    assert.equal(parsePromptCommand('hello').type, 'usage');
  });
});
