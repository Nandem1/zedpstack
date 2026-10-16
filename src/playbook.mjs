import fs from 'node:fs';
import path from 'node:path';
import { zedpstackRoot } from './paths.mjs';

export function loadPlaybook(playbookId) {
  const root = path.join(zedpstackRoot(), 'playbooks', playbookId);
  const defPath = path.join(root, 'playbook.json');
  if (!fs.existsSync(defPath)) {
    throw new Error(`Playbook not found: ${playbookId}`);
  }
  const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
  return { root, def };
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
