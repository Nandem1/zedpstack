/**
 * Best-effort detection of who drives the chat. Workers never depend on it;
 * doctor shows it so the user can tell which host config matters.
 */
export function detectOrchestratorHost(env = process.env) {
  if (env.ZEDPSTACK_ORCHESTRATOR) {
    return { id: env.ZEDPSTACK_ORCHESTRATOR, note: 'from ZEDPSTACK_ORCHESTRATOR' };
  }
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) {
    return { id: 'claude-code', note: `Claude Code (${env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'})` };
  }
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM) {
    return { id: 'codex', note: 'Codex session' };
  }
  if (env.CURSOR_AGENT === '1' || env.CURSOR_TRACE_ID) {
    return { id: 'cursor', note: 'Cursor IDE or agent session' };
  }
  if (env.ZED_TERM || env.TERM_PROGRAM === 'zed') {
    return { id: 'zed', note: 'Zed terminal' };
  }
  return { id: 'unknown', note: 'Set ZEDPSTACK_ORCHESTRATOR=cursor|claude-code|codex|zed to override' };
}
