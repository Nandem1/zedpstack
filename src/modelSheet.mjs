/**
 * Parse / write pstack-compatible model override sheets (setup-pstack shape).
 * Maps sheet roles to zedpstack RoleBinding keys for dispatch workers.
 */

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** pstack sheet role label → zedpstack config role ids */
export const SHEET_TO_ZEDPSTACK_ROLES = {
  'how explorer': ['how-explorer', 'explorer'],
  'how explainer': ['how-explainer', 'synthesizer'],
  'why investigators': ['why-investigator'],
  'why synthesizer': ['why-synthesizer'],
  'architect runners': ['architect-runner-a', 'architect-runner-b'],
  'interrogate reviewers': [
    'interrogate-reviewer-a',
    'interrogate-reviewer-b',
    'interrogate-reviewer-c',
  ],
  'reflect tooling': ['reflect-reviewer-tooling'],
  'reflect judgment': ['reflect-reviewer-judgment'],
  'reflect divergent': ['reflect-reviewer-divergent'],
  'reflect synthesizer': ['reflect-synthesize'],
  'reflect judgment, divergent, synthesizer': [
    'reflect-reviewer-judgment',
    'reflect-reviewer-divergent',
    'reflect-synthesize',
  ],
  'architect ground': ['architect-ground'],
  'architect synthesize': ['architect-synthesize'],
  'interrogate lead': ['interrogate-lead'],
};

/** One model on these rows applies to every mapped zed role (not a positional panel). */
const SHARED_SHEET_ROLES = new Set(['reflect judgment, divergent, synthesizer']);

/** List length sets subagent count; extra entries must not overwrite the last slot. */
const PANEL_SHEET_ROLES = new Set(['architect runners', 'interrogate reviewers']);

/**
 * @param {string} slugWithOptionalEffort e.g. "haiku @high" or "gpt-6.1-sol"
 */
export function parseModelValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'inherit-parent' || trimmed === 'auto') {
    return { model: trimmed, effort: null };
  }
  const at = trimmed.lastIndexOf(' @');
  if (at > 0) {
    const model = trimmed.slice(0, at).trim();
    const effort = trimmed.slice(at + 2).trim().toLowerCase();
    if (EFFORT_LEVELS.has(effort)) {
      return { model, effort };
    }
  }
  return { model: trimmed, effort: null };
}

/**
 * @param {string} text full sheet body
 * @returns {{ roles: Record<string, string[]>, defaultEffort: string|null, sessionHook: string|null, droppedLines: string[] }}
 */
export function parseModelSheet(text) {
  const roles = {};
  let defaultEffort = null;
  let sessionHook = null;
  const droppedLines = [];

  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (stripped.startsWith('---')) continue;

    const colon = stripped.indexOf(':');
    if (colon < 0) {
      droppedLines.push(stripped);
      continue;
    }
    const key = stripped.slice(0, colon).trim().toLowerCase();
    const value = stripped.slice(colon + 1).trim();

    if (key === 'default effort') {
      defaultEffort = value;
      continue;
    }
    if (key === 'session hook') {
      sessionHook = value;
      continue;
    }

    const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
    roles[key] = parts;
  }

  return { roles, defaultEffort, sessionHook, droppedLines };
}

/**
 * Infer CLI runtime from model slug (heuristic; user can override in config).
 */
export function inferRuntimeForModel(model) {
  if (!model || model === 'inherit-parent' || model === 'auto') {
    return 'claude';
  }
  const s = model.toLowerCase();
  if (
    s.includes('gpt') ||
    s.includes('codex') ||
    s.includes('-sol') ||
    s.includes('o3') ||
    s.includes('o4') ||
    s.startsWith('chatgpt')
  ) {
    return 'codex';
  }
  return 'claude';
}

function bindingForModel(raw, globalEffort) {
  const { model, effort } = parseModelValue(raw);
  if (!model || model === 'inherit-parent' || model === 'auto') {
    return null;
  }
  const binding = {
    runtime: inferRuntimeForModel(model),
    model,
    permissionProfile: 'read-only',
  };
  const eff = effort ?? globalEffort;
  if (eff) binding.effort = eff;
  return binding;
}

/**
 * Human-readable warnings for panel overflow (extra models with no slot).
 * @param {{ sheetRole: string, model: string, index: number }[]} overflows
 */
export function sheetBindingOverflowWarnings(overflows) {
  return overflows.map(
    (entry) =>
      `Sheet row "${entry.sheetRole}" has more models than slots; ignored "${entry.model}" at position ${entry.index + 1}.`,
  );
}

/**
 * Build zedpstack config role entries from a parsed sheet.
 * @returns {{
 *   bindings: Record<string, { runtime: string, model: string, permissionProfile: string, effort?: string }>,
 *   overflows: { sheetRole: string, model: string, index: number }[],
 * }}
 */
export function bindingsFromSheet(parsed, { defaultEffort = 'session' } = {}) {
  const globalEffort =
    parsed.defaultEffort && parsed.defaultEffort !== 'session'
      ? parsed.defaultEffort
      : defaultEffort !== 'session'
        ? defaultEffort
        : null;

  const out = {};
  const overflows = [];

  for (const [sheetRole, values] of Object.entries(parsed.roles)) {
    const zedRoles = SHEET_TO_ZEDPSTACK_ROLES[sheetRole];
    if (!zedRoles?.length) continue;

    const usable = values
      .map((raw) => ({ raw, binding: bindingForModel(raw, globalEffort) }))
      .filter((entry) => entry.binding);

    if (SHARED_SHEET_ROLES.has(sheetRole) && usable.length === 1) {
      const binding = usable[0].binding;
      for (const targetRole of zedRoles) {
        out[targetRole] = binding;
      }
      continue;
    }

    const panel = PANEL_SHEET_ROLES.has(sheetRole);

    usable.forEach(({ raw, binding }, index) => {
      if (panel && index >= zedRoles.length) {
        overflows.push({
          sheetRole,
          model: parseModelValue(raw).model,
          index,
        });
        return;
      }
      const targetRole = panel
        ? zedRoles[index]
        : (zedRoles[index] ?? zedRoles[zedRoles.length - 1]);
      out[targetRole] = binding;
    });
  }

  return { bindings: out, overflows };
}

export function defaultSheetTemplate() {
  return `# pstack model configuration (zedpstack sync)

how explorer: haiku
how explainer: gpt-6.1-sol
why investigators: gpt-6.1-sol
why synthesizer: haiku
architect ground: haiku
architect runners: gpt-6.1-sol, haiku
architect synthesize: gpt-6.1-sol
interrogate reviewers: haiku, haiku, haiku
interrogate lead: gpt-6.1-sol
reflect tooling: haiku
reflect judgment: haiku
reflect divergent: haiku
reflect synthesizer: haiku

default effort: session
session hook: on
`;
}
