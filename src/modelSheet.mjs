/**
 * Parse / write pstack-compatible model override sheets (setup-pstack shape).
 * Maps sheet roles to zedpstack RoleBinding keys for dispatch workers.
 */

import { classifyModelSlug } from './modelRouting.mjs';

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** pstack sheet role label → zedpstack config role ids */
export const SHEET_TO_ZEDPSTACK_ROLES = {
  'how explorer': ['how-explorer', 'explorer'],
  'how explainer': ['how-explainer', 'synthesizer'],
  'why investigators': ['why-investigator'],
  'why synthesizer': ['why-synthesizer'],
  'architect runners': ['architect-runner-a', 'architect-runner-b', 'architect-runner-c'],
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

/** Generic config aliases; kept when another sheet row still maps to them. */
export const GENERIC_ALIAS_ROLES = new Set(['explorer', 'synthesizer']);

/** Union of zedpstack worker role ids driven by the model sheet. */
export function zedpstackManagedRoles() {
  const ids = new Set();
  for (const mapped of Object.values(SHEET_TO_ZEDPSTACK_ROLES)) {
    for (const role of mapped) ids.add(role);
  }
  return [...ids].sort();
}

/** Whether a parsed sheet still contains a row that maps to this alias role. */
export function sheetRowMapsToZedRole(parsed, zedRole) {
  for (const [sheetRole, mapped] of Object.entries(SHEET_TO_ZEDPSTACK_ROLES)) {
    if (!mapped.includes(zedRole)) continue;
    if (sheetRole in parsed.roles) return true;
  }
  return false;
}

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
 * Infer worker CLI runtime from model slug (see modelRouting.mjs).
 */
export function inferRuntimeForModel(model) {
  if (!model || model === 'inherit-parent' || model === 'auto') {
    return 'claude';
  }
  const { model: slug } = parseModelValue(model);
  return classifyModelSlug(slug).runtime;
}

function bindingForModel(raw, globalEffort) {
  const { model, effort } = parseModelValue(raw);
  if (!model || model === 'inherit-parent' || model === 'auto') {
    return null;
  }
  const routed = classifyModelSlug(model);
  const binding = {
    runtime: routed.runtime,
    model: routed.model,
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
 * Zed role ids touched by the current sheet rows (including inherit-parent / auto).
 * @param {ReturnType<typeof parseModelSheet>} parsed
 */
export function rolesAffectedBySheet(parsed, options) {
  return bindingsFromSheet(parsed, options).rolesAffected;
}

/**
 * Build zedpstack config role entries from a parsed sheet.
 * @returns {{
 *   bindings: Record<string, { runtime: string, model: string, permissionProfile: string, effort?: string }>,
 *   overflows: { sheetRole: string, model: string, index: number }[],
 *   rolesAffected: string[],
 *   skippedInheritance: { sheetRole: string, zedRole: string, raw: string }[],
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
  const rolesAffectedSet = new Set();
  const skippedInheritance = [];

  for (const [sheetRole, values] of Object.entries(parsed.roles)) {
    const zedRoles = SHEET_TO_ZEDPSTACK_ROLES[sheetRole];
    if (!zedRoles?.length) continue;

    if (SHARED_SHEET_ROLES.has(sheetRole)) {
      for (const targetRole of zedRoles) {
        rolesAffectedSet.add(targetRole);
      }
      const entries = values.map((raw) => ({
        raw,
        binding: bindingForModel(raw, globalEffort),
      }));
      const usable = entries.filter((entry) => entry.binding);
      if (usable.length === 1) {
        const binding = usable[0].binding;
        for (const targetRole of zedRoles) {
          out[targetRole] = binding;
        }
      } else {
        for (const { raw } of entries) {
          const { model } = parseModelValue(raw);
          if (model === 'inherit-parent' || model === 'auto') {
            for (const zedRole of zedRoles) {
              skippedInheritance.push({ sheetRole, zedRole, raw });
            }
          }
        }
      }
      continue;
    }

    const panel = PANEL_SHEET_ROLES.has(sheetRole);

    if (panel) {
      for (let index = 0; index < zedRoles.length; index++) {
        const targetRole = zedRoles[index];
        rolesAffectedSet.add(targetRole);
        const raw = values[index];
        if (raw === undefined) continue;
        const binding = bindingForModel(raw, globalEffort);
        if (!binding) {
          skippedInheritance.push({ sheetRole, zedRole: targetRole, raw });
          continue;
        }
        out[targetRole] = binding;
      }
      values.forEach((raw, index) => {
        if (index >= zedRoles.length) {
          overflows.push({
            sheetRole,
            model: parseModelValue(raw).model,
            index,
          });
        }
      });
      continue;
    }

    if (values.length === 1 && zedRoles.length > 1) {
      const raw = values[0];
      for (const targetRole of zedRoles) {
        rolesAffectedSet.add(targetRole);
      }
      const binding = bindingForModel(raw, globalEffort);
      if (!binding) {
        for (const zedRole of zedRoles) {
          skippedInheritance.push({ sheetRole, zedRole, raw });
        }
        continue;
      }
      for (const targetRole of zedRoles) {
        out[targetRole] = binding;
      }
      continue;
    }

    values.forEach((raw, index) => {
      const targetRole = zedRoles[index] ?? zedRoles[zedRoles.length - 1];
      rolesAffectedSet.add(targetRole);
      const binding = bindingForModel(raw, globalEffort);
      if (!binding) {
        skippedInheritance.push({ sheetRole, zedRole: targetRole, raw });
        return;
      }
      out[targetRole] = binding;
    });
  }

  return {
    bindings: out,
    overflows,
    rolesAffected: [...rolesAffectedSet].sort(),
    skippedInheritance,
  };
}

export function defaultSheetTemplate() {
  return `# zedpstack worker sheet: pstack role lines (as in /setup-pstack), values are worker CLI slugs.
# claude: haiku, sonnet, opus, fable · codex: gpt-6.1-sol, ... · cursor: composer-2.5, ...
# Prefix a slug to force the CLI when it exists on several: cursor:claude-opus-5-5, codex:gpt-6-sol.
# Panel rows (lists) run one worker per entry. Edit with /setup-zedpstack; check with "dispatch doctor --human".

feature, refactoring: opus
bug-fix: fable
perf-issue: fable
hillclimb: fable
judgment and prose: opus
strongest judgment: fable
how explorer: haiku
how explainer: sonnet
why investigators: sonnet
why synthesizer: sonnet
reflect tooling: haiku
reflect judgment, divergent, synthesizer: sonnet
arena runners: opus, gpt-6.1-sol, sonnet
arena cross-judge pool: opus, gpt-6.1-sol
swarm workers: sonnet
architect runners: gpt-6.1-sol, opus
interrogate reviewers: opus, gpt-6.1-sol, sonnet

default effort: session
`;
}
