import { pstackSkillDir, readPstackFile } from './pstack.mjs';

const SIMPLE_HOW_ANGLE =
  'Cover the full scope of the question in one pass (zedpstack simple how path). ' +
  'Find entry points, trace flow, map abstractions, and note boundaries.';

function fillPstackTemplate(text, replacements) {
  let out = text;
  for (const [key, value] of Object.entries(replacements)) {
    const token = `{${key}}`;
    out = out.split(token).join(value);
  }
  return out;
}

function workerHeader(role) {
  return [
    `You are a read-only zedpstack worker (${role}).`,
    'Repository under review is the process cwd unless context says otherwise.',
    'Prefer Read, Grep, Glob. Shell only when the pstack template requires git/gh and your runtime allows read-only exec.',
    '',
  ].join('\n');
}

export function buildHowExplorerPrompt({ question, explorationAngle = SIMPLE_HOW_ANGLE }) {
  const howDir = pstackSkillDir('how');
  const template = readPstackFile(howDir, 'references', 'explorer-prompt.md');
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    EXPLORATION_ANGLE: explorationAngle,
  });
  return workerHeader('pstack how explorer') + body;
}

export function buildHowExplainerPrompt({ question, explorerFindings }) {
  const howDir = pstackSkillDir('how');
  const template = readPstackFile(howDir, 'references', 'explainer-prompt.md');
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    EXPLORER_FINDINGS_ALL: explorerFindings,
  });
  return (
    workerHeader('pstack how explainer') +
    'Prefer Read/Grep/Glob; read-only shell (rg/grep/cat/git log) only to verify a detail.\n\n' +
    body
  );
}

export function buildWhyInvestigatorPrompt({ question, context = '' }) {
  const whyDir = pstackSkillDir('why');
  const template = readPstackFile(whyDir, 'references', 'investigator-prompt.md');
  const sourcePlaybook = readPstackFile(
    whyDir,
    'references',
    'sources',
    'code-archaeology.md',
  );
  const anchor = context.trim() || 'Discover target files/symbols via Read/Grep/Glob and git log when shell is available.';
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    FILES_WITH_LINE_RANGES: anchor,
    SYMBOLS: '(discover from question and repo)',
    COMMIT_LIST: '(run git log on target files when permitted)',
    PR_NUMBERS: '(extract from merge commits when permitted)',
    TICKET_IDS: '(from PR bodies when found)',
    SOURCE_NAME: 'code-archaeology / source control',
    SOURCE_PLAYBOOK_SECTION: sourcePlaybook,
  });
  return workerHeader('pstack why investigator') + body;
}

export function buildWhySynthesizerPrompt({ question, investigatorFindings, skippedSources }) {
  const whyDir = pstackSkillDir('why');
  const template = readPstackFile(whyDir, 'references', 'synthesizer-prompt.md');
  const epistemics = readPstackFile(whyDir, 'references', 'epistemics.md');
  const body = fillPstackTemplate(template, {
    QUESTION: question,
    FILES_WITH_LINE_RANGES: '(see investigator findings)',
    SYMBOLS: '(see investigator findings)',
    ALL_INVESTIGATOR_FINDINGS: investigatorFindings,
    SKIPPED_SOURCES_WITH_REASONS:
      skippedSources ??
      'MCP sources (Linear, Slack, Notion, etc.) not searched in zedpstack v0.3; git/code only.',
  });
  return workerHeader('pstack why synthesizer') + `## Epistemics\n\n${epistemics}\n\n${body}`;
}

export function buildArchitectRunnerPrompt({ goal, grounding, candidateLabel }) {
  const architectDir = pstackSkillDir('architect');
  const runner = readPstackFile(architectDir, 'references', 'runner-prompt.md');
  const rationale = readPstackFile(architectDir, 'references', 'rationale-template.md');
  const redFlags = readPstackFile(architectDir, 'references', 'design-red-flags.md');
  return [
    workerHeader(`pstack architect runner ${candidateLabel}`),
    runner,
    '',
    '## Design task',
    goal,
    '',
    '## Phase A grounding',
    grounding || '(none yet)',
    '',
    `## Candidate ${candidateLabel}`,
    'Read-only design package. No file writes. Types/signatures + rationale only.',
    '',
    '### Rationale template (follow shape)',
    rationale,
    '',
    '### Design red flags (screen your design)',
    redFlags,
  ].join('\n');
}

export function buildArchitectSynthesizePrompt({ goal, candidateTexts }) {
  const blocks = Object.entries(candidateTexts)
    .map(([id, text]) => `### Candidate ${id}\n\n${text}`)
    .join('\n\n');
  return [
    workerHeader('pstack architect synthesize'),
    'Synthesize arena-style: pick a base design, note grafts from losers, per pstack architect Phase B–E (design only, no implementation).',
    '',
    '## Task',
    goal,
    '',
    '## Candidate packages',
    blocks,
  ].join('\n');
}

export function buildInterrogateReviewerPrompt({ intent, codeContext, reviewerLabel }) {
  const dir = pstackSkillDir('interrogate');
  const template = readPstackFile(dir, 'references', 'reviewer-prompt.md');
  const rubric = readPstackFile(dir, 'references', 'rubric.md');
  const quality = readPstackFile(dir, 'references', 'code-quality-review.md');
  const body = fillPstackTemplate(template, {
    INTENT: intent,
    DIFF_OR_FILES: codeContext || '(no diff supplied; review files named in intent)',
    RUBRIC_CONTENTS: rubric,
    CODE_QUALITY_CONTENTS: quality,
  });
  return workerHeader(`pstack interrogate ${reviewerLabel}`) + body;
}

export function buildInterrogateLeadPrompt({ intent, reviewerOutputs }) {
  const dir = pstackSkillDir('interrogate');
  const framework = readPstackFile(dir, 'references', 'lead-judgment.md');
  const merged = Object.entries(reviewerOutputs)
    .map(([id, text]) => `## ${id}\n\n${text}`)
    .join('\n\n');
  return [
    workerHeader('pstack interrogate lead'),
    framework,
    '',
    '## Stated intent',
    intent,
    '',
    '## Reviewer findings',
    merged,
    '',
    'Produce final verdict buckets: Act on / Consider / Noted / Dismissed.',
  ].join('\n');
}

export function buildReflectReviewerPrompt({ lens, transcriptDigest }) {
  const dir = pstackSkillDir('reflect');
  const file =
    lens === 'tooling'
      ? 'tooling-reviewer.md'
      : lens === 'divergent'
        ? 'divergent-reviewer.md'
        : 'judgment-reviewer.md';
  const template = readPstackFile(dir, 'references', file);
  const digestBlock = `\n\n## Session digest (zedpstack)\n\n${transcriptDigest}\n`;
  const body = template.replace(
    'Read the active transcript at <ABSOLUTE_PATH> (or use the digest below if no path is given).',
    'Use the session digest below (no transcript file in zedpstack).',
  );
  return workerHeader(`pstack reflect ${lens}`) + body + digestBlock;
}

export function buildReflectSynthesizePrompt({ reviewerOutputs }) {
  const dir = pstackSkillDir('reflect');
  const template = readPstackFile(dir, 'references', 'synthesizer.md');
  let body = template;
  body = body.replace('<JUDGMENT_OUTPUT>', reviewerOutputs.judgment ?? '');
  body = body.replace('<TOOLING_OUTPUT>', reviewerOutputs.tooling ?? '');
  body = body.replace('<DIVERGENT_OUTPUT>', reviewerOutputs.divergent ?? '');
  return workerHeader('pstack reflect synthesizer') + body;
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
