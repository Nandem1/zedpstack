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
    assert.deepEqual(plan.models.cursor.map((m) => m.model), ['composer-2.5', 'composer-2.5-fast']);

    const bugFix = plan.roles.find((r) => r.role === 'bug-fix');
    assert.equal(bugFix.source, 'pstack-default');
    assert.match(bugFix.problems[0], /credits/);
    assert.ok(plan.problemCount > 0);

    assert.equal(plan.questions.roleGroups.length, 4);
    assert.ok(plan.questions.roleGroups.every((q) => q.options.length <= 4 && q.multiSelect));
    assert.deepEqual(plan.questions.effort.options.map((o) => o.label), ['default', 'medium', 'high']);
    assert.ok(!plan.questions.models.claude.options.some((o) => o.label === 'fable'), 'unusable models are not offered');
    assert.ok(plan.questions.panel.options.length <= 4, 'panel fits a 4-option question');
  });

  it('rejects a model that does not run and writes valid answers, keeping other rows', async () => {
    await assert.rejects(writeSetup({ roles: { 'bug-fix': ['fable'] } }), /does not run/);
    await assert.rejects(writeSetup({ roles: { 'bug-fix': ['gpt-6.1-sol', 'opus'] } }), /takes one model/);
    const typed = await writeSetup({ roles: { 'strongest judgment': ['claude-opus-5-5'] }, dryRun: true });
    assert.match(typed.sheet, /^strongest judgment: claude-opus-5-5$/m, 'full ids typed via Other are probed, not rejected');
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
