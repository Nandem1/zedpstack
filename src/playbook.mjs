import fs from 'node:fs';
import path from 'node:path';
import { buildHowExplainerPrompt, buildHowExplorerPrompt } from './pstackPrompts.mjs';
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

export function loadStepPrompt({ playbook, stepDef, goal, repoRoot, exploreText }) {
  const source = stepDef.promptSource;
  if (source === 'pstack-how-explorer') {
    return buildHowExplorerPrompt({ question: goal });
  }
  if (source === 'pstack-how-explainer') {
    return buildHowExplainerPrompt({
      question: goal,
      explorerFindings: exploreText ?? '',
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
