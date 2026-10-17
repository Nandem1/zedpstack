/**
 * Best-effort detection of who is driving the chat (orchestrator).
 * Workers always use dispatch + config; this is for setup UX only.
 */

export function detectOrchestratorHost() {
  if (process.env.ZEDPSTACK_ORCHESTRATOR) {
    return { id: process.env.ZEDPSTACK_ORCHESTRATOR, note: 'from ZEDPSTACK_ORCHESTRATOR' };
  }
  if (process.env.CURSOR_AGENT === '1' || process.env.CURSOR_TRACE_ID) {
    return { id: 'cursor', note: 'Cursor IDE / agent session' };
  }
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION) {
    return { id: 'claude-code', note: 'Claude Code via ACP or terminal' };
  }
  if (process.env.CODEX_HOME || process.env.OPENAI_API_KEY) {
    return { id: 'codex', note: 'Codex CLI context (heuristic)' };
  }
  return { id: 'unknown', note: 'Set ZEDPSTACK_ORCHESTRATOR=cursor|claude-code|codex|zed' };
}
