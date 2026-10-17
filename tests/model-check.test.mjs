import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkModel,
  cliRejection,
  expectedModelFor,
  isAlias,
  modelLabel,
  modelWarning,
  normalizeModelId,
} from '../src/modelCheck.mjs';

describe('normalizeModelId', () => {
  const same = [
    ['Composer 2.5', 'composer-2.5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-opus-5-5[effort=high,fast=true]', 'claude-opus-5-5'],
    ['Claude Opus 5.5 1M High', 'claude-opus-5-5'],
    ['Grok 4.7  High', 'grok-4.7'],
    ['GPT-6.1-Sol 256K Extra High', 'gpt-6.1-sol'],
    ['cursor:composer-2.5', 'composer-2.5'],
  ];
  for (const [a, b] of same) {
    it(`${a} == ${b}`, () => assert.equal(normalizeModelId(a), normalizeModelId(b)));
  }

  const different = [
    ['claude-opus-4-8', 'claude-opus-5-5'],
    ['composer-2.5-fast', 'composer-2.5'],
    ['claude-opus-5', 'claude-opus-5-5'],
  ];
  for (const [a, b] of different) {
    it(`${a} != ${b}`, () => assert.notEqual(normalizeModelId(a), normalizeModelId(b)));
  }

  it('keeps null', () => assert.equal(normalizeModelId(null), null));
});

describe('isAlias', () => {
  it('knows family names and inherit values, not concrete ids', () => {
    for (const a of ['opus', 'sonnet', 'haiku', 'fable', 'default', 'auto', 'claude:opus', 'Opus']) assert.ok(isAlias(a), a);
    for (const c of ['claude-opus-5-5', 'composer-2.5', 'gpt-6.1-sol', 'cursor:opus-x']) assert.ok(!isAlias(c), c);
  });
});

describe('expectedModelFor', () => {
  const probeCache = { 'claude:opus': { ok: true, effective: 'claude-opus-4-8' } };
  it('a concrete slug expects itself', () => {
    assert.equal(expectedModelFor({ runtime: 'claude', model: 'claude-opus-5-5' }, { probeCache }), 'claude-opus-5-5');
  });
  it('an alias expects what the probe saw, or nothing', () => {
    assert.equal(expectedModelFor({ runtime: 'claude', model: 'opus' }, { probeCache }), 'claude-opus-4-8');
    assert.equal(expectedModelFor({ runtime: 'claude', model: 'haiku' }, { probeCache }), null);
    assert.equal(expectedModelFor({ runtime: 'claude', model: 'opus' }), null);
  });
});

describe('checkModel', () => {
  const rows = [
    ['no evidence', { requested: 'claude-opus-5-5', effective: null, expected: 'claude-opus-5-5' }, 'unverified', 'no evidence'],
    ['concrete match', { requested: 'claude-opus-5-5', effective: 'claude-opus-5-5', expected: 'claude-opus-5-5' }, 'ok', 'ran claude-opus-5-5'],
    ['snapshot suffix', { requested: 'claude-haiku-4-5', effective: 'claude-haiku-4-5-20251001', expected: 'claude-haiku-4-5' }, 'ok', null],
    ['Cursor display name', { requested: 'composer-2.5', effective: 'Composer 2.5', expected: 'composer-2.5' }, 'ok', null],
    ['bracket params', { requested: 'claude-opus-5-5', effective: 'claude-opus-5-5[effort=high]', expected: 'claude-opus-5-5' }, 'ok', null],
    ['prefix trap 4-8 vs 5-5', { requested: 'claude-opus-5-5', effective: 'claude-opus-4-8', expected: 'claude-opus-5-5' }, 'mismatch', 'expected claude-opus-5-5, CLI ran claude-opus-4-8'],
    ['alias with probe, moved', { requested: 'opus', effective: 'claude-opus-4-8', expected: 'claude-opus-5-5' }, 'mismatch', null],
    ['alias with probe, same', { requested: 'opus', effective: 'claude-opus-4-8-20260101', expected: 'claude-opus-4-8' }, 'ok', null],
    ['alias, no probe', { requested: 'opus', effective: 'claude-opus-4-8', expected: null }, 'unverified', 'alias opus resolved to claude-opus-4-8'],
    ['record without expectedModel', { requested: 'claude-opus-5-5', effective: 'claude-opus-4-8' }, 'mismatch', null],
  ];
  for (const [name, input, state, note] of rows) {
    it(name, () => {
      const check = checkModel(input);
      assert.equal(check.state, state);
      if (note) assert.equal(check.note, note);
      assert.equal(check.requested, input.requested);
      assert.equal(check.effective, input.effective ?? null);
    });
  }
});

describe('modelLabel and modelWarning', () => {
  it('shows requested → effective, a warning mark on mismatch and a note on aliases', () => {
    assert.equal(modelLabel(checkModel({ requested: 'composer-2.5', effective: 'Composer 2.5', expected: 'composer-2.5' })), 'composer-2.5');
    assert.equal(modelLabel(checkModel({ requested: 'gpt-6.1-sol', effective: null })), 'gpt-6.1-sol');
    assert.equal(
      modelLabel(checkModel({ requested: 'opus', effective: 'claude-opus-4-8', expected: 'claude-opus-5-5' })),
      'opus → claude-opus-4-8 ⚠ esperado claude-opus-5-5',
    );
    assert.equal(modelLabel(checkModel({ requested: 'haiku', effective: 'claude-haiku-4-5-20251001' })), 'haiku → claude-haiku-4-5 (alias)');
    assert.equal(modelLabel(checkModel({ requested: 'opus', effective: 'claude-opus-4-8', expected: 'claude-opus-4-8' })), 'opus → claude-opus-4-8');
  });

  it('warns only on mismatch', () => {
    assert.equal(modelWarning(checkModel({ requested: 'opus', effective: 'claude-opus-4-8' })), null);
    assert.match(
      modelWarning(checkModel({ requested: 'claude-opus-5-5', effective: 'claude-opus-4-8' })),
      /^⚠ model mismatch: requested claude-opus-5-5, the CLI ran claude-opus-4-8, expected claude-opus-5-5\./,
    );
  });
});

describe('cliRejection', () => {
  it('names the installed CLI when the API wants a newer one', () => {
    const msg = cliRejection({
      runtime: 'claude',
      model: 'claude-opus-5-5',
      cliVersion: '2.1.195 (Claude Code)',
      text: 'API Error: 400 The model claude-opus-5-5 requires Claude Code 2.1.280 or later.',
    });
    assert.match(msg, /^claude CLI 2\.1\.195 cannot run claude-opus-5-5: the API requires 2\.1\.280 or later\. Update the claude CLI/);
  });

  it('leaves other failures alone', () => {
    assert.equal(cliRejection({ runtime: 'claude', model: 'fable', cliVersion: '2.1.195', text: 'Fable 5 requires usage credits.' }), null);
    assert.equal(cliRejection({ runtime: 'codex', model: 'gpt-6.1-sol', cliVersion: null, text: 'fake failure' }), null);
  });
});
