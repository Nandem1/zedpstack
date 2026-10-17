import fs from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function sessionFile(repoRoot) {
  return path.join(path.resolve(repoRoot), '.zedpstack', 'session.json');
}

export function auditFile(repoRoot) {
  return path.join(path.resolve(repoRoot), '.zedpstack', 'orchestrator-audit.jsonl');
}

export function startSession(repoRoot, { pid = process.pid } = {}) {
  const repo = path.resolve(repoRoot);
  const dir = path.join(repo, '.zedpstack');
  fs.mkdirSync(dir, { recursive: true });
  const existing = readSession(repo);
  const marker = {
    startedAt: new Date().toISOString(),
    repo,
    pid,
  };
  if (existing?.editsAllowed !== undefined) marker.editsAllowed = existing.editsAllowed;
  fs.writeFileSync(sessionFile(repo), `${JSON.stringify(marker)}\n`, 'utf8');
  return marker;
}

export function readSession(repoRoot) {
  const file = sessionFile(repoRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    const started = Date.parse(marker.startedAt);
    if (!Number.isFinite(started) || Date.now() - started > SESSION_TTL_MS) return null;
    return marker;
  } catch {
    return null;
  }
}

export function endSession(repoRoot) {
  fs.rmSync(sessionFile(repoRoot), { force: true });
}

export function allowEdits(repoRoot, on) {
  const file = sessionFile(repoRoot);
  const marker = readSession(repoRoot) ?? JSON.parse(fs.readFileSync(file, 'utf8'));
  marker.editsAllowed = Boolean(on);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker)}\n`, 'utf8');
  return marker;
}

export function findSessionRepoFromCwd(cwd) {
  let dir = path.resolve(cwd ?? process.cwd());
  const { root } = path.parse(dir);
  while (true) {
    const file = path.join(dir, '.zedpstack', 'session.json');
    if (fs.existsSync(file) && readSession(dir)) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

/** Realpath of the deepest existing ancestor: engines report /private/tmp for a /tmp cwd on macOS. */
function realPath(target) {
  const rest = [];
  let dir = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function repoRelative(targetPath, repoRoot) {
  return path.relative(realPath(repoRoot), realPath(targetPath));
}

function isInsideRepo(targetPath, repoRoot) {
  const rel = repoRelative(targetPath, repoRoot);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isZedpstackInternal(targetPath, repoRoot) {
  const rel = repoRelative(targetPath, repoRoot);
  return rel === '.zedpstack' || rel.startsWith(`.zedpstack${path.sep}`);
}

function editTargetPath(tool, input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path ?? input.path ?? input.notebook_path ?? null;
}

function stripQuotedStrings(command) {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const q = command[i];
    if (q !== "'" && q !== '"') {
      out += q;
      continue;
    }
    i++;
    while (i < command.length && command[i] !== q) {
      if (q === '"' && command[i] === '\\') i++;
      i++;
    }
    if (i < command.length) i++;
    out += ' ';
  }
  return out;
}

function stripShellNoise(command) {
  let cmd = stripQuotedStrings(command);
  cmd = cmd.replace(/=>/g, '  ').replace(/->/g, '  ');
  cmd = cmd
    .replace(/\d+>&\d+/g, ' ')
    .replace(/\d+>\s*&\d+/g, ' ')
    .replace(/\d+>\s*\/dev\/null\b/g, ' ')
    .replace(/&>\s*&?\d+\b/g, ' ')
    .replace(/&>\s*\/dev\/null\b/g, ' ')
    .replace(/>\s*&\d+\b/g, ' ');
  return cmd;
}

function resolveBashTarget(target, cwd, repoRoot) {
  const resolved = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  if (!isInsideRepo(resolved, repoRoot) || isZedpstackInternal(resolved, repoRoot)) return null;
  return repoRelative(resolved, repoRoot) || target;
}

function fileRedirectTarget(command) {
  const re = /(^|[\s;|])(>>|>)\s*([^\s|;&]+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    const op = match[2];
    const target = match[3];
    const gt = match.index + match[1].length;
    if (op === '>' && command[gt + 1] === '=') continue;
    return target;
  }
  return null;
}

/**
 * Bash repo-write detection is heuristic: false negatives and false positives are possible.
 */
export function bashLooksLikeRepoWrite(command, repoRoot, cwd = repoRoot) {
  if (!command || typeof command !== 'string') return null;
  const cmd = command;
  const workCwd = cwd ?? repoRoot;
  if (/\bsed\b[^|;\n]*\s-i/.test(cmd) || /\bperl\b[^|;\n]*\s-(?:pi|0777i|i)/.test(cmd)) {
    return '(bash mutation)';
  }
  if (/\btee\b/.test(cmd)) {
    const teeTarget = cmd.match(/\btee\b(?:\s+-a)?\s+([^\s|;&]+)/);
    if (teeTarget) {
      const hit = resolveBashTarget(teeTarget[1], workCwd, repoRoot);
      if (hit) return hit;
    }
  }
  const cleaned = stripShellNoise(cmd);
  const redirectTarget = fileRedirectTarget(cleaned);
  if (redirectTarget) {
    const hit = resolveBashTarget(redirectTarget, workCwd, repoRoot);
    if (hit) return hit;
  }
  const heredoc = cmd.match(/cat\s+<<['"]?(\w+)['"]?\s*>\s*([^\s|;&]+)/);
  if (heredoc) {
    const hit = resolveBashTarget(heredoc[2], workCwd, repoRoot);
    if (hit) return hit;
  }
  return null;
}

export function appendDenialAudit(repoRoot, { tool, path: targetPath }) {
  const file = auditFile(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), tool, path: targetPath })}\n`, 'utf8');
}

export function readDenialAudit(repoRoot) {
  const file = auditFile(repoRoot);
  if (!fs.existsSync(file)) return { count: 0, last: null };
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  let last = null;
  for (const line of lines) {
    try {
      last = JSON.parse(line);
    } catch {
      // skip bad lines
    }
  }
  return { count: lines.length, last };
}

export function decide({ tool, input, cwd, env = process.env }) {
  try {
    if (env.ZEDPSTACK_AGENT_ID) return { deny: false, reason: null };
    const repoRoot = findSessionRepoFromCwd(cwd);
    if (!repoRoot) return { deny: false, reason: null };
    const session = readSession(repoRoot);
    if (!session) return { deny: false, reason: null };
    if (session.editsAllowed) return { deny: false, reason: null };
    return editVerdict({ tool, input, cwd, repoRoot });
  } catch {
    return { deny: false, reason: null };
  }
}

/**
 * The edit rules alone, for a repo the caller already decided is guarded: the
 * PreToolUse hook gets it from the session marker, the ACP hub from its session cwd.
 */
export function editVerdict({ tool, input, cwd, repoRoot }) {
  try {
    if (EDIT_TOOLS.has(tool)) {
      const target = editTargetPath(tool, input);
      if (!target) return { deny: false, reason: null };
      const resolved = path.isAbsolute(target) ? target : path.resolve(cwd ?? repoRoot, target);
      if (!isInsideRepo(resolved, repoRoot)) return { deny: false, reason: null };
      if (isZedpstackInternal(resolved, repoRoot)) return { deny: false, reason: null };
      const auditPath = repoRelative(resolved, repoRoot) || target;
      return {
        deny: true,
        reason: `orchestrator edit guard: delegate this edit via spawn_agent (${auditPath})`,
        repoRoot,
        auditPath,
      };
    }

    if (tool === 'Bash') {
      const command = input?.command ?? input?.cmd ?? '';
      const hit = bashLooksLikeRepoWrite(command, repoRoot, cwd ?? repoRoot);
      if (!hit) return { deny: false, reason: null };
      return {
        deny: true,
        reason: `orchestrator edit guard: delegate this edit via spawn_agent (bash: ${hit})`,
        repoRoot,
        auditPath: hit,
      };
    }

    return { deny: false, reason: null };
  } catch {
    return { deny: false, reason: null };
  }
}
