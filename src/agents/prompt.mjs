import path from 'node:path';
import { pstackSkillDir } from '../pstack.mjs';

/**
 * pstack's `subagent_type` values, mapped to what the worker must read first.
 * Mirrors the Codex mapping in poteto-mode/references/codex-tools.md.
 */
const SUBAGENT_TYPES = {
  'general-purpose': null,
  'poteto-agent': { skill: 'poteto-mode', file: 'SKILL.md', why: "poteto-mode's full agent style, including its inline Principles index" },
  'comment-sicko': { skill: 'poteto-mode', file: 'references/agents/comment-sicko.md', why: 'the comment-sicko reviewer role' },
};

export function normalizeSubagentType(raw) {
  const bare = (raw ?? 'general-purpose').replace(/^pstack:/, '');
  if (bare.startsWith('effort-')) return 'general-purpose';
  const value = bare.replace(/-(low|medium|high|xhigh|max)$/, '');
  if (!(value in SUBAGENT_TYPES)) {
    throw new Error(
      `unknown subagent_type "${raw}". Use one of: ${Object.keys(SUBAGENT_TYPES).join(', ')}`,
    );
  }
  return value;
}

/** `pstack:poteto-agent-high` carries an effort level, like pstack's effort agents. */
export function effortFromSubagentType(raw) {
  const match = /-(low|medium|high|xhigh|max)$/.exec(raw ?? '');
  return match ? match[1] : null;
}

function skillPath(skill, file = 'SKILL.md') {
  return path.join(pstackSkillDir(skill), file);
}

/**
 * @param {{
 *   task: string,
 *   subagentType: string,
 *   skills?: string[],
 *   readonly: boolean,
 *   cwd: string,
 *   worktree?: { branch: string } | null,
 *   role?: string | null,
 *   runtime: string,
 *   model: string,
 * }} o
 */
export function buildAgentPrompt(o) {
  const lines = [
    `You are a subagent launched by zedpstack for a pstack workflow${o.role ? ` (role: ${o.role})` : ''}.`,
    `You run on ${o.runtime} with model ${o.model}. pstack skills name Claude Code tools (Read, Grep, Agent, ...); use your own equivalent tools.`,
    '',
  ];

  const reads = [];
  const type = SUBAGENT_TYPES[o.subagentType];
  if (type) reads.push(`- ${skillPath(type.skill, type.file)} (${type.why})`);
  for (const skill of o.skills ?? []) reads.push(`- ${skillPath(skill)} (the ${skill} skill)`);
  if (reads.length) {
    lines.push('Before any work, read these files in full and follow them:', ...reads, '');
  }

  lines.push(`Working directory: ${o.cwd}`);
  if (o.readonly) {
    lines.push('You are read-only. Do not create, edit, or delete files, and do not run commands that change state. Report what you find.');
  } else if (o.worktree) {
    lines.push(
      `You may edit files inside the working directory only. It is a dedicated git worktree on branch ${o.worktree.branch}.`,
      'zedpstack commits your changes when you finish, so do not commit, push, or switch branches. Run the checks you need to prove the change works.',
    );
  } else {
    lines.push('You may edit files inside the working directory only. Do not commit, push, or switch branches.');
  }
  lines.push(
    'Do not ask questions; nobody can answer mid-run. Decide, and state each assumption in your report.',
    'Your final message is returned verbatim to the orchestrator. Make it the complete report: findings with file:line evidence, what you changed, and what you verified.',
    '',
    '## Task',
    '',
    o.task.trim(),
    '',
  );
  return lines.join('\n');
}
