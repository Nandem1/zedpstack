export const MANIFEST_SCHEMA_VERSION = 1;
export const ZEDPSTACK_VERSION = '0.7.0';
export const RUNS_DIR = '.zedpstack/runs';
export const AGENTS_DIR = '.zedpstack/agents';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

export const PERMISSION_PROFILES = {
  'read-only': {
    id: 'read-only',
    description: 'No repo writes; Claude gets Read/Grep/Glob only, Codex read-only sandbox, Cursor ask mode',
  },
  'workspace-write': {
    id: 'workspace-write',
    description: 'Edits inside the agent cwd (a git worktree by default); Codex/Cursor sandboxed, Claude limited to an allowlist of shell commands',
  },
};
