import { spawnSync } from 'node:child_process';
import { PERMISSION_PROFILES } from './constants.mjs';

const CLAUDE_READ_ONLY_TOOLS = 'Read,Grep,Glob';

export function assertPermissionProfile(binding) {
  const profile = PERMISSION_PROFILES[binding.permissionProfile];
  if (!profile) {
    throw new Error(`Unknown permissionProfile: ${binding.permissionProfile}`);
  }
  if (binding.permissionProfile !== 'read-only') {
    throw new Error(`Session 1 only supports read-only; got ${binding.permissionProfile}`);
  }
}

export function verifyRuntimeAvailable(binding) {
  const bin = binding.runtime === 'claude' ? 'claude' : 'codex';
  const check = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (check.error || check.status !== 0) {
    throw new Error(`CLI "${bin}" not available or failed --version`);
  }
  return (check.stdout || check.stderr || '').trim().split('\n')[0];
}

/**
 * Falla antes de lanzar si el perfil read-only de Claude no puede aplicarse.
 */
export function verifyClaudeReadOnlyProfile({ repoRoot }) {
  if (!repoRoot) {
    throw new Error('claude read-only requires repoRoot for --add-dir');
  }
  const probe = spawnSync('claude', ['--help'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(`claude CLI probe failed: ${probe.error?.message ?? probe.status}`);
  }
  if (!probe.stdout.includes('--tools')) {
    throw new Error('claude CLI lacks --tools flag; cannot enforce read-only profile');
  }
}

/**
 * Build argv for worker — no shell, no model-generated strings in sh -c.
 */
export function buildClaudeArgv({ model, permissionProfile, repoRoot }) {
  if (permissionProfile !== 'read-only') {
    throw new Error('claude adapter: only read-only in v0');
  }
  verifyClaudeReadOnlyProfile({ repoRoot });
  return [
    'claude',
    '-p',
    '--model',
    model,
    '--permission-mode',
    'dontAsk',
    '--tools',
    CLAUDE_READ_ONLY_TOOLS,
    '--add-dir',
    repoRoot,
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
  ];
}

const CODEX_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

export function buildCodexArgv({
  model,
  repoRoot,
  permissionProfile,
  resultOutPath,
  effort,
}) {
  if (permissionProfile !== 'read-only') {
    throw new Error('codex adapter: only read-only in v0');
  }
  const argv = [
    'codex',
    'exec',
    '-s',
    'read-only',
    '-m',
    model,
    '-C',
    repoRoot,
    '-o',
    resultOutPath,
  ];
  if (effort && CODEX_EFFORT_LEVELS.has(effort)) {
    argv.push('-c', `model_reasoning_effort="${effort}"`);
  }
  return argv;
}

export function workerEnv(runtime, baseEnv = process.env) {
  const common = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'];
  const claudeKeys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const codexKeys = ['OPENAI_API_KEY', 'CODEX_HOME'];
  const allow =
    runtime === 'claude'
      ? [...common, ...claudeKeys]
      : runtime === 'codex'
        ? [...common, ...codexKeys]
        : common;

  const env = {};
  for (const key of allow) {
    if (baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }
  return env;
}
