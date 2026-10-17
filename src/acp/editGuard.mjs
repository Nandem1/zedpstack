import { editVerdict } from '../guard.mjs';

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);
const ASKING_MODES = { claude: new Set(['default', 'plan']), cursor: new Set(['ask', 'plan']) };
export const EDIT_REFUSED_TEXT = 'El orquestador no edita archivos: delega con spawn_agent (o /edits on)';

function editPaths(call, repo) {
  const paths = [
    ...(call.locations ?? []).map((location) => location.path),
    ...(call.content ?? []).filter((block) => block.type === 'diff').map((block) => block.path),
  ];
  return paths.filter((target) => typeof target === 'string').map((target) => editVerdict({
    tool: 'Write', input: { file_path: target }, cwd: repo, repoRoot: repo,
  })).filter((verdict) => verdict.deny).map((verdict) => verdict.auditPath);
}

/** Owns partial tool calls and deduplication for one engine, whose ids can be reused after a restart. */
export function createEditGuard({ repo, report }) {
  const calls = new Map();
  function remember(call) {
    const key = call.toolCallId;
    const state = calls.get(key) ?? { call: {}, refused: false, warned: false };
    state.call = { ...state.call, ...Object.fromEntries(Object.entries(call).filter(([, value]) => value != null)) };
    calls.set(key, state);
    return state;
  }

  return {
    permission(params, editsAllowed) {
      if (editsAllowed) return null;
      const call = params.toolCall ?? {};
      const state = remember(call);
      let target;
      if (EDIT_KINDS.has(state.call.kind)) {
        target = editPaths(state.call, repo)[0] ?? '(herramienta interna)';
      } else if (state.call.kind === 'execute') {
        const input = state.call.rawInput ?? {};
        const command = input.command ?? input.cmd ?? state.call.title;
        const verdict = editVerdict({ tool: 'Bash', input: { command }, cwd: repo, repoRoot: repo });
        if (verdict.deny) target = verdict.auditPath;
      }
      if (!target) return null;
      if (!state.refused) {
        state.refused = true;
        report({ tool: 'session/request_permission', path: target, text: EDIT_REFUSED_TEXT });
      }
      const reject = ['reject_once', 'reject_always'].map((kind) => params.options?.find((option) => option.kind === kind)).find(Boolean);
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
    },

    observe(update, editsAllowed) {
      if (!['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
      if (!update.toolCallId || update.toolCallId.startsWith('zp-')) return;
      const state = remember(update);
      if (editsAllowed || state.refused || state.warned || !EDIT_KINDS.has(state.call.kind)) return;
      const target = editPaths(state.call, repo)[0];
      if (!target) return;
      state.warned = true;
      report({
        tool: update.sessionUpdate,
        path: target,
        text: `⚠ El orquestador editó ${target} directamente (el motor no pidió permiso). Revisa con git diff; usa /edits on si fue intencional.`,
      });
    },
  };
}

export function editsStatus({ editsAllowed, runtime, mode }) {
  const enforcement = ASKING_MODES[runtime]?.has(mode) ? 'bloquea' : 'solo avisa';
  return `editsAllowed=${editsAllowed}. Ediciones directas ${editsAllowed ? 'permitidas' : 'desactivadas'} en este hilo.`
    + ` Motor ${runtime}, modo ${mode ?? 'desconocido'}. Con /edits off, ${enforcement}.`
    + ' El hub rechaza las solicitudes de permiso de edición; las ediciones internas sin permiso solo generan un aviso.'
    + ' Para el hook de Claude Code, usa dispatch install. /edits no cambia ese hook ni el modo del motor.';
}
