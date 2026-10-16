import path from 'node:path';
import { pstackSkillDir, readPstackFile } from './pstack.mjs';

const SIMPLE_EXPLORATION_ANGLE =
  'Cover the full scope of the question in one pass (zedpstack simple how path). ' +
  'Find entry points, trace flow, map abstractions, and note boundaries.';

function fillPstackTemplate(text, replacements) {
  let out = text;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

export function buildHowExplorerPrompt({ question, explorationAngle = SIMPLE_EXPLORATION_ANGLE }) {
  const howDir = pstackSkillDir('how');
  const template = readPstackFile(howDir, 'references', 'explorer-prompt.md');
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    EXPLORATION_ANGLE: explorationAngle,
  });
  return [
    'You are a read-only codebase explorer (pstack how skill, zedpstack worker).',
    `Repository under review is the working directory.`,
    '',
    body,
  ].join('\n');
}

export function buildHowExplainerPrompt({ question, explorerFindings }) {
  const howDir = pstackSkillDir('how');
  const template = readPstackFile(howDir, 'references', 'explainer-prompt.md');
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    EXPLORER_FINDINGS_ALL: explorerFindings,
  });
  return [
    'You are a read-only explainer (pstack how skill, zedpstack worker).',
    'Do not run shell commands; use Read, Grep, Glob only if you must verify a detail.',
    '',
    body,
  ].join('\n');
}

export function potetoModeRoutingExcerpt() {
  try {
    const potetoDir = pstackSkillDir('poteto-mode');
    const skill = readPstackFile(potetoDir, 'SKILL.md');
    const start = skill.indexOf('## Non-negotiables');
    const end = skill.indexOf('## Principles');
    if (start >= 0 && end > start) {
      return skill.slice(start, end).trim();
    }
    return skill.slice(0, 2000);
  } catch {
    return '(poteto-mode SKILL.md not available; install pstack)';
  }
}
