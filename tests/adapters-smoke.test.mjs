import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaybook, loadStepPrompt } from '../src/playbook.mjs';
import {
  buildInterrogateReviewerPrompt,
  buildWhyInvestigatorPrompt,
} from '../src/pstackPrompts.mjs';

const PLAYBOOKS = [
  'how-investigation',
  'why-rationale',
  'architect-sketch',
  'interrogate-review',
  'reflect-session',
];

describe('pstack playbooks smoke', () => {
  for (const id of PLAYBOOKS) {
    it(`loads ${id}`, () => {
      const pb = loadPlaybook(id);
      assert.ok(pb.def.steps.length >= 2);
      assert.ok(pb.def.upstream?.pstackSkill || id === 'how-investigation');
    });
  }

  it('why investigator prompt includes code-archaeology', () => {
    const t = buildWhyInvestigatorPrompt({ question: 'Why auth?' });
    assert.match(t, /code-archaeology|source control/i);
  });

  it('interrogate reviewer embeds rubric', () => {
    const t = buildInterrogateReviewerPrompt({
      intent: 'Fix bug',
      codeContext: 'diff here',
      reviewerLabel: 'A',
    });
    assert.match(t, /adversarial code reviewer/i);
  });

  it('reflect reviewer embeds digest', () => {
    const pb = loadPlaybook('reflect-session');
    const step = pb.def.steps[0];
    const text = loadStepPrompt({
      playbook: pb,
      stepDef: step,
      goal: 'goal',
      repoRoot: '/tmp',
      context: 'TRANSCRIPT_LINE_1',
      priorTexts: {},
    });
    assert.match(text, /TRANSCRIPT_LINE_1/);
  });

  it('architect sketch first step renders', () => {
    const pb = loadPlaybook('architect-sketch');
    const step = pb.def.steps[0];
    const text = loadStepPrompt({
      playbook: pb,
      stepDef: step,
      goal: 'Design cache layer',
      repoRoot: '/tmp',
      context: '',
      priorTexts: {},
    });
    assert.match(text, /explorer|how/i);
  });
});
