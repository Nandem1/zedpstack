import fs from 'node:fs';
import path from 'node:path';
import {
  buildArchitectRunnerPrompt,
  buildArchitectSynthesizePrompt,
  buildHowExplainerPrompt,
  buildHowExplorerPrompt,
  buildInterrogateLeadPrompt,
  buildInterrogateReviewerPrompt,
  buildReflectReviewerPrompt,
  buildReflectSynthesizePrompt,
  buildWhyInvestigatorPrompt,
  buildWhySynthesizerPrompt,
} from './pstackPrompts.mjs';
import { resolvePstackInstall } from './pstack.mjs';
import { zedpstackRoot } from './paths.mjs';

export function loadPlaybook(playbookId, _visited = new Set()) {
  if (_visited.has(playbookId)) {
    throw new Error(`Playbook alias cycle: ${playbookId}`);
  }
  _visited.add(playbookId);

  const root = path.join(zedpstackRoot(), 'playbooks', playbookId);
  const defPath = path.join(root, 'playbook.json');
  if (!fs.existsSync(defPath)) {
    throw new Error(`Playbook not found: ${playbookId}`);
  }
  const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
  if (def.aliasOf) {
    const target = loadPlaybook(def.aliasOf, _visited);
    return {
      ...target,
      requestedId: playbookId,
      def: {
        ...target.def,
        id: def.id ?? playbookId,
        aliasOf: def.aliasOf,
        deprecated: def.deprecated ?? true,
      },
    };
  }
  return { root, def, requestedId: playbookId };
}

export function renderTemplate(templatePath, vars) {
  let text = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

export function loadPrompt(playbookRoot, templateName, vars) {
  const templatePath = path.join(playbookRoot, 'prompts', templateName);
  return renderTemplate(templatePath, vars);
}

function priorText(priorTexts, ...ids) {
  for (const id of ids) {
    if (priorTexts[id]) {
      return priorTexts[id];
    }
  }
  return '';
}

export function loadStepPrompt({ playbook, stepDef, goal, repoRoot, context, priorTexts = {} }) {
  const source = stepDef.promptSource;
  const meta = stepDef.promptMeta ?? {};

  if (source === 'pstack-how-explorer') {
    return buildHowExplorerPrompt({ question: goal });
  }
  if (source === 'pstack-how-explainer') {
    return buildHowExplainerPrompt({
      question: goal,
      explorerFindings: priorText(priorTexts, 'explore', 'ground'),
    });
  }
  if (source === 'pstack-why-investigator') {
    return buildWhyInvestigatorPrompt({ question: goal, context });
  }
  if (source === 'pstack-why-synthesizer') {
    return buildWhySynthesizerPrompt({
      question: goal,
      investigatorFindings: priorText(priorTexts, 'investigate'),
    });
  }
  if (source === 'pstack-architect-runner') {
    return buildArchitectRunnerPrompt({
      goal,
      grounding: priorText(priorTexts, 'ground'),
      candidateLabel: meta.candidateLabel ?? 'A',
    });
  }
  if (source === 'pstack-architect-synthesize') {
    const candidates = {};
    for (const [id, text] of Object.entries(priorTexts)) {
      if (id.startsWith('sketch-')) {
        candidates[id] = text;
      }
    }
    return buildArchitectSynthesizePrompt({ goal, candidateTexts: candidates });
  }
  if (source === 'pstack-interrogate-reviewer') {
    return buildInterrogateReviewerPrompt({
      intent: goal,
      codeContext: context,
      reviewerLabel: meta.reviewerLabel ?? 'A',
    });
  }
  if (source === 'pstack-interrogate-lead') {
    const outputs = {};
    for (const [id, text] of Object.entries(priorTexts)) {
      if (id.startsWith('review-')) {
        outputs[id] = text;
      }
    }
    return buildInterrogateLeadPrompt({ intent: goal, reviewerOutputs: outputs });
  }
  if (source === 'pstack-reflect-reviewer') {
    const digest = context || goal;
    return buildReflectReviewerPrompt({ lens: meta.lens ?? 'judgment', transcriptDigest: digest });
  }
  if (source === 'pstack-reflect-synthesize') {
    return buildReflectSynthesizePrompt({
      reviewerOutputs: {
        judgment: priorTexts['reflect-judgment'],
        tooling: priorTexts['reflect-tooling'],
        divergent: priorTexts['reflect-divergent'],
      },
    });
  }

  if (!stepDef.promptTemplate) {
    throw new Error(`Step ${stepDef.id} has no promptTemplate or promptSource`);
  }
  const vars = { GOAL: goal, REPO_ROOT: repoRoot };
  return loadPrompt(playbook.root, stepDef.promptTemplate, vars);
}

export function attachPstackUpstreamMeta(def) {
  if (!def.upstream?.pstackSkill) {
    return def;
  }
  try {
    const install = resolvePstackInstall();
    return {
      ...def,
      upstream: {
        ...def.upstream,
        pstackVersion: install.version,
        pstackRoot: install.root,
      },
    };
  } catch {
    return def;
  }
}

export const PLAYBOOK_ROUTING = [
  { match: /cómo funciona|how does|walkthrough|capas|ownership|where should/i, playbook: 'how-investigation' },
  { match: /por qué|why does|rationale|motivación|postmortem/i, playbook: 'why-rationale' },
  { match: /architect|diseña|design this|sketch/i, playbook: 'architect-sketch' },
  { match: /interrogate|adversarial|stress test|review this/i, playbook: 'interrogate-review' },
  { match: /reflect|\/reflect/i, playbook: 'reflect-session' },
];
