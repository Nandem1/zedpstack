/**
 * Worker model sheet: the pstack override sheet shape (`/setup-pstack` role
 * rows), but every value is a slug a worker CLI can spawn (`haiku`,
 * `gpt-6.1-sol`, `composer-2.5`, or `runtime:slug`). The orchestrator host's own
 * sheet is never read here, so a Cursor-only slug cannot leak into `claude -p`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyModelSlug, validateModelForRuntime } from './modelRouting.mjs';
import { parseModelSheet, parseModelValue } from './modelSheet.mjs';
import { resolvePstackInstall } from './pstack.mjs';

const INHERIT = new Set(['inherit-parent', 'auto']);

/** Built-in fallback when pstack's models.json cannot be read. */
const FALLBACK_TIERS = { default: 'opus', strongest: 'fable', panel: ['opus', 'fable', 'sonnet'] };

export function workerSheetPath(env = process.env) {
  if (env.ZEDPSTACK_MODEL_SHEET) return path.resolve(env.ZEDPSTACK_MODEL_SHEET);
  return path.join(os.homedir(), '.zedpstack', 'pstack-models.md');
}

function loadPstackModelsJson() {
  try {
    const { root } = resolvePstackInstall();
    const file = path.join(root, 'models.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // pstack missing: built-in tiers still let explicit models work
  }
  return null;
}

/** `reflect judgment, divergent, synthesizer` also answers to `reflect divergent`. */
function roleAliases(label) {
  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [label];
  const prefix = parts[0].split(' ').slice(0, -1).join(' ');
  return [label, parts[0], ...parts.slice(1).map((p) => (prefix ? `${prefix} ${p}` : p))];
}

function toEntry(raw, defaultEffort) {
  const { model, effort } = parseModelValue(raw);
  if (INHERIT.has(model)) {
    return { raw, inherit: true };
  }
  const routed = classifyModelSlug(model);
  const entry = { raw, model: routed.model, runtime: routed.runtime, confident: routed.confident };
  const eff = effort ?? defaultEffort;
  if (eff) entry.effort = eff;
  return entry;
}

/**
 * @returns {{
 *   sheetPath: string,
 *   sheetExists: boolean,
 *   defaultEffort: string | null,
 *   roles: Record<string, { source: 'sheet' | 'pstack-default', entries: object[] }>,
 *   pstackDefaults: boolean,
 * }}
 */
export function loadWorkerModels({ sheetPath = workerSheetPath() } = {}) {
  const exists = fs.existsSync(sheetPath);
  const parsed = parseModelSheet(exists ? fs.readFileSync(sheetPath, 'utf8') : '');
  const defaultEffort =
    parsed.defaultEffort && parsed.defaultEffort !== 'session' ? parsed.defaultEffort : null;

  const modelsJson = loadPstackModelsJson();
  const tiers = { ...FALLBACK_TIERS, ...(modelsJson?.tiers ?? {}) };
  const roles = {};

  for (const row of modelsJson?.roles ?? []) {
    const tier = tiers[row.models] ?? tiers.default;
    const values = Array.isArray(tier) ? tier : [tier];
    roles[row.role] = {
      source: 'pstack-default',
      entries: values.map((v) => toEntry(v, defaultEffort)),
    };
  }
  for (const [label, values] of Object.entries(parsed.roles)) {
    roles[label] = { source: 'sheet', entries: values.map((v) => toEntry(v, defaultEffort)) };
  }

  const index = {};
  for (const label of Object.keys(roles)) {
    for (const alias of roleAliases(label)) {
      if (!index[alias] || roles[label].source === 'sheet') index[alias] = label;
    }
  }

  return {
    sheetPath,
    sheetExists: exists,
    defaultEffort,
    roles,
    index,
    tiers,
    pstackDefaults: Boolean(modelsJson),
  };
}

/**
 * Decide runtime + model for one spawn.
 *
 * @param {{ role?: string, slot?: number, model?: string, runtime?: string, effort?: string }} req
 * @returns {{ runtime: string, model: string, effort?: string, role: string | null, source: string, notes: string[] }}
 */
export function resolveAgentModel(req, models = loadWorkerModels()) {
  const notes = [];
  let entry;
  let source;
  const role = req.role ? req.role.trim().toLowerCase() : null;

  if (req.model) {
    entry = toEntry(req.model, null);
    source = 'explicit';
    if (entry.inherit) {
      throw new Error(`model "${req.model}" means "parent model"; pass a concrete slug instead`);
    }
  } else if (role) {
    const label = models.index[role];
    if (!label) {
      throw new Error(
        `unknown role "${req.role}". Known roles: ${Object.keys(models.index).sort().join(', ')}`,
      );
    }
    const { entries, source: rowSource } = models.roles[label];
    const slot = req.slot ?? 0;
    if (slot < 0 || slot >= entries.length) {
      throw new Error(`role "${label}" has ${entries.length} slot(s); slot ${slot} is out of range`);
    }
    entry = entries[slot];
    source = rowSource === 'sheet' ? `sheet:${label}` : `pstack-default:${label}`;
    if (entry.inherit) {
      const fallback = models.tiers.default;
      notes.push(
        `role "${label}" is ${entry.raw} (parent model); a spawned CLI cannot inherit it, so it runs on the pstack default "${fallback}"`,
      );
      entry = toEntry(Array.isArray(fallback) ? fallback[0] : fallback, models.defaultEffort);
    }
  } else {
    const fallback = models.tiers.default;
    entry = toEntry(Array.isArray(fallback) ? fallback[0] : fallback, models.defaultEffort);
    source = 'pstack-default:single-role';
  }

  let runtime = entry.runtime;
  if (req.runtime) {
    const check = validateModelForRuntime(entry.model, req.runtime);
    if (!check.ok) notes.push(check.message);
    runtime = req.runtime;
  } else if (!entry.confident) {
    notes.push(`slug "${entry.model}" is not recognized; running it on claude. Use "cursor:" or "codex:" to choose`);
  }

  const out = { runtime, model: entry.model, role: role ?? null, source, notes };
  const effort = req.effort ?? entry.effort;
  if (effort && effort !== 'session') out.effort = effort;
  return out;
}

/** Compact view for the orchestrator (`list_models`). */
export function describeWorkerModels(models = loadWorkerModels()) {
  const roles = {};
  for (const [label, { source, entries }] of Object.entries(models.roles)) {
    roles[label] = {
      source,
      slots: entries.map((e) =>
        e.inherit ? { value: e.raw, inherit: true } : { runtime: e.runtime, model: e.model, ...(e.effort ? { effort: e.effort } : {}) },
      ),
    };
  }
  return {
    sheetPath: models.sheetPath,
    sheetExists: models.sheetExists,
    defaultEffort: models.defaultEffort ?? 'session',
    roles,
  };
}
