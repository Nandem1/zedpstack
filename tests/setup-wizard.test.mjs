import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSetupPlan, writeSetup } from '../src/setupWizard.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

describe('setup wizard', () => {
  let sb;
  before(() => {
    sb = makeSandbox({ sheet: 'how explorer: haiku\narchitect ground: haiku\ndefault effort: session\n' });
    process.env.ZEDPSTACK_HOME = path.join(sb.root, 'zp-home');
    const codexHome = path.join(sb.root, 'codex-home');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'workhorse', visibility: 'list', priority: 1 },
        { slug: 'gpt-hidden', visibility: 'hide', priority: 2 },
      ] }),
    );
    process.env.CODEX_HOME = codexHome;
  });

  it('plans with probed Claude aliases, the Codex catalog and Cursor first-party models', async () => {
    const plan = await buildSetupPlan();
    const claude = Object.fromEntries(plan.models.claude.map((m) => [m.model, m]));
    assert.equal(claude.opus.ok, true);
    assert.equal(claude.opus.effective, 'claude-opus-fake');
    assert.equal(claude.fable.ok, false, 'fake CLI rejects fable like an account without credits');
    assert.deepEqual(plan.models.codex.map((m) => m.model), ['gpt-6.1-sol']);
    const cursorIds = plan.models.cursor.map((m) => m.model);
    assert.ok(cursorIds.includes('composer-2.5') && cursorIds.includes('grok-4.7-high'), 'third-party Cursor models are listed');
    assert.ok(!cursorIds.includes('auto'));

    const bugFix = plan.roles.find((r) => r.role === 'bug-fix');
    assert.equal(bugFix.source, 'pstack-default');
    assert.match(bugFix.problems[0], /credits/);
    assert.ok(plan.problemCount > 0);

    const explorer = plan.roles.find((r) => r.role === 'how explorer');
    assert.equal(explorer.slots[0].effective, 'claude-haiku-fake');
    assert.equal(explorer.slots[0].pin, 'claude-haiku-fake', 'an alias carries the probed concrete id');
    assert.match(explorer.recommendations[0], /^haiku es un alias y hoy corre claude-haiku-fake; fija claude-haiku-fake/);
    assert.deepEqual(plan.roles.find((r) => r.role === 'bug-fix').recommendations, [], 'an alias that does not run has nothing to pin');

    assert.equal(plan.questions.roleGroups.length, 4);
    assert.ok(plan.questions.roleGroups.every((q) => q.options.length <= 4 && q.multiSelect));
    assert.deepEqual(plan.questions.effort.options.map((o) => o.label), ['default', 'medium', 'high']);
    assert.ok(!plan.questions.model.options.some((o) => o.label === 'fable'), 'unusable models are not offered');
    assert.ok(plan.questions.model.options.length <= 4 && plan.questions.panel.multiSelect);
    assert.ok(plan.questions.model.options.some((o) => /grok/.test(o.label)), 'Grok is reachable from the shortlist');
    assert.ok(!plan.questions.change && !plan.questions.provider, 'no change/provider gates');
    assert.ok(plan.more.includes('cursor-grok-4.6-high'));
  });

  it('rejects a model that does not run and writes valid answers, keeping other rows', async () => {
    await assert.rejects(writeSetup({ roles: { 'bug-fix': ['fable'] } }), /does not run/);
    await assert.rejects(writeSetup({ roles: { 'bug-fix': ['gpt-6.1-sol', 'opus'] } }), /takes one model/);
    const typed = await writeSetup({ roles: { 'strongest judgment': ['claude-opus-5-5'] }, dryRun: true });
    assert.match(typed.sheet, /^strongest judgment: claude-opus-5-5$/m, 'full ids typed via Other are probed, not rejected');
    assert.deepEqual(typed.warnings, [], 'a concrete id needs no warning');
    const alias = await writeSetup({ roles: { 'strongest judgment': ['opus'] }, dryRun: true });
    assert.match(alias.sheet, /^strongest judgment: opus$/m, 'the alias is written as given');
    assert.deepEqual(alias.warnings, ['strongest judgment: opus is an alias the CLI runs as claude-opus-fake today; write claude-opus-fake to pin it']);
    const grok = await writeSetup({ roles: { 'swarm workers': ['grok-4.7-high'], 'hillclimb': ['gpt-5.2'] }, dryRun: true });
    assert.match(grok.sheet, /^swarm workers: grok-4\.7-high$/m);
    assert.match(grok.sheet, /^hillclimb: cursor:gpt-5\.2$/m, 'bare ids only Cursor knows get the cursor: prefix');
    const res = await writeSetup({
      defaultEffort: 'default',
      roles: { 'bug-fix': ['gpt-6.1-sol'], arena: ['opus', 'composer-2.5'] },
    });
    const text = fs.readFileSync(sb.sheetPath, 'utf8');
    assert.equal(res.written, true);
    assert.match(text, /^bug-fix: gpt-6\.1-sol$/m);
    assert.match(text, /^arena runners: opus, composer-2\.5$/m);
    assert.match(text, /^arena cross-judge pool: opus, composer-2\.5$/m);
    assert.match(text, /^how explorer: haiku$/m);
    assert.match(text, /^architect ground: haiku$/m, 'batch-only rows survive');
    assert.match(text, /^default effort: session$/m);
    const again = await writeSetup({ defaultEffort: 'default', roles: { 'bug-fix': ['gpt-6.1-sol'], arena: ['opus', 'composer-2.5'] } });
    assert.equal(again.changed, false, 'idempotent');
  });
});
