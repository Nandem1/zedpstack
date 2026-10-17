import { spawnSync } from 'node:child_process';
import { PERMISSION_PROFILES } from './constants.mjs';

const CLAUDE_READ_ONLY_TOOLS = 'Read,Grep,Glob';
const CLAUDE_WRITE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

/**
 * Bash patterns a Claude writer may run without a prompt. `claude -p` denies
 * anything else, so the list is the effective shell policy for Claude writers.
 * Codex and Cursor writers rely on their own sandboxes instead.
 */
export const DEFAULT_CLAUDE_WRITE_ALLOWED_TOOLS = [
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(ls *)',
  'Bash(rg *)',
  'Bash(npm test *)',
  'Bash(npm run *)',
  'Bash(pnpm *)',
  'Bash(bun *)',
  'Bash(node *)',
  'Bash(npx *)',
];

export const RUNTIME_BINARIES = { claude: 'claude', codex: 'codex', cursor: 'agent' };

export function assertPermissionProfile(binding) {
  if (!PERMISSION_PROFILES[binding.permissionProfile]) {
    throw new Error(`Unknown permissionProfile: ${binding.permissionProfile}`);
  }
}

const versionCache = new Map();

export function verifyRuntimeAvailable(binding) {
  const bin = RUNTIME_BINARIES[binding.runtime];
  if (!bin) {
    throw new Error(`Unsupported runtime: ${binding.runtime}`);
  }
  if (versionCache.has(bin)) return versionCache.get(bin);
  const versionArgs = binding.runtime === 'cursor' ? ['-v'] : ['--version'];
  const check = spawnSync(bin, versionArgs, { encoding: 'utf8' });
  if (check.error || check.status !== 0) {
    throw new Error(`CLI "${bin}" not available or failed ${versionArgs[0]}`);
  }
  const version = (check.stdout || check.stderr || '').trim().split('\n')[0];
  versionCache.set(bin, version);
  return version;
}

/**
 * Fails before launch when the Claude CLI cannot enforce a tool allowlist.
 */
export function verifyClaudeReadOnlyProfile({ repoRoot }) {
  if (!repoRoot) {
    throw new Error('claude worker requires repoRoot for --add-dir');
  }
  if (versionCache.has('claude:--tools')) return;
  const probe = spawnSync('claude', ['--help'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(`claude CLI probe failed: ${probe.error?.message ?? probe.status}`);
  }
  if (!probe.stdout.includes('--tools')) {
    throw new Error('claude CLI lacks --tools flag; cannot enforce permission profile');
  }
  versionCache.set('claude:--tools', true);
}

function assertKnownProfile(runtime, permissionProfile) {
  if (!PERMISSION_PROFILES[permissionProfile]) {
    throw new Error(`${runtime} adapter: unknown permission profile ${permissionProfile}`);
  }
}

/**
 * Build argv for a Claude worker. The prompt goes over stdin, never argv.
 */
export function buildClaudeArgv({
  model,
  permissionProfile,
  repoRoot,
  effort,
  extraReadDirs = [],
  allowedTools = DEFAULT_CLAUDE_WRITE_ALLOWED_TOOLS,
  probe = true,
}) {
  assertKnownProfile('claude', permissionProfile);
  if (probe) verifyClaudeReadOnlyProfile({ repoRoot });
  const write = permissionProfile === 'workspace-write';
  const argv = [
    'claude',
    '-p',
    '--model',
    model,
    '--permission-mode',
    write ? 'acceptEdits' : 'dontAsk',
    '--tools',
    write ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_ONLY_TOOLS,
  ];
  if (write && allowedTools.length) {
    argv.push('--allowedTools', allowedTools.join(','));
  }
  for (const dir of [repoRoot, ...extraReadDirs]) {
    argv.push('--add-dir', dir);
  }
  if (effort && EFFORT_LEVELS.has(effort)) {
    argv.push('--effort', effort);
  }
  argv.push('--verbose', '--output-format', 'stream-json', '--include-partial-messages');
  return argv;
}

/**
 * Cursor Agent CLI. Read-only runs in `ask` mode with no `--force`; writers get
 * `--force` only together with the sandbox so shell stays inside the worktree.
 */
export function buildCursorArgv({ model, permissionProfile, repoRoot, extraReadDirs = [] }) {
  assertKnownProfile('cursor', permissionProfile);
  if (!repoRoot) {
    throw new Error('cursor worker requires repoRoot');
  }
  const write = permissionProfile === 'workspace-write';
  const argv = ['agent', '-p', '--trust', '--workspace', repoRoot];
  if (write) {
    argv.push('--force', '--sandbox', 'enabled');
  } else {
    argv.push('--mode', 'ask');
  }
  for (const dir of extraReadDirs) {
    argv.push('--add-dir', dir);
  }
  argv.push('--model', model, '--output-format', 'stream-json');
  return argv;
}

/**
 * Codex worker argv without the trailing stdin marker (`-`); the runner adds it.
 */
export function buildCodexArgv({
  model,
  repoRoot,
  permissionProfile,
  resultOutPath,
  effort,
  extraWriteDirs = [],
}) {
  assertKnownProfile('codex', permissionProfile);
  const write = permissionProfile === 'workspace-write';
  const argv = ['codex', 'exec', '-s', write ? 'workspace-write' : 'read-only', '-m', model, '-C', repoRoot];
  if (write) {
    for (const dir of extraWriteDirs) argv.push('--add-dir', dir);
  }
  if (effort && CODEX_EFFORT_LEVELS.has(effort)) {
    argv.push('-c', `model_reasoning_effort="${effort}"`);
  }
  argv.push('-o', resultOutPath);
  return argv;
}

export function workerEnv(runtime, baseEnv = process.env) {
  const common = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
  const perRuntime = {
    claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
    codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
    cursor: ['CURSOR_API_KEY'],
  };
  const env = {};
  for (const key of [...common, ...(perRuntime[runtime] ?? [])]) {
    if (baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }
  return env;
}
