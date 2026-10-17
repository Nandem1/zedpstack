import fs from 'node:fs';
import path from 'node:path';
import { zedpstackRoot } from './paths.mjs';

/**
 * SKILL.md's body, so the skill, the MCP `/zedpstack` prompt and the ACP hub's
 * first-prompt prefix never drift.
 */
export function orchestratorPrompt(task) {
  const root = zedpstackRoot();
  const text = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const body = text.replace(/^---[\s\S]*?---\s*/, '').trim();
  return `${body}\n\n(zedpstack lives at ${root}.)\n\n## Task\n\n${task ?? ''}\n`;
}
