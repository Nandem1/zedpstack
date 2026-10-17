import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBoardCommand, isChildCommand } from '../src/acp/commands.mjs';

describe('acp commands', () => {
  it('recognizes board with or without slash, on the first line only', () => {
    assert.equal(isBoardCommand('/board'), true);
    assert.equal(isBoardCommand('board  \nmore'), true);
    assert.equal(isBoardCommand('show the board'), false);
    assert.equal(isBoardCommand('hello\n/board'), false);
  });

  it('matches only slash commands the engine announced', () => {
    const child = [{ name: 'compact' }, { name: 'review' }];
    assert.equal(isChildCommand('/compact', child), true);
    assert.equal(isChildCommand('/review src/x.mjs\nmore', child), true);
    assert.equal(isChildCommand('compact', child), false);
    assert.equal(isChildCommand('/spawn how explorer :: hi', child), false);
    assert.equal(isChildCommand('/compact', []), false);
  });
});
