/**
 * Requested vs effective model. A worker asks for a slug, the CLI reports the
 * model it actually runs; this module decides whether the two are the same
 * model, so no verdict is attributed to a model the user did not ask for.
 *
 *   ok          the CLI ran the expected model
 *   unverified  no evidence, or an alias with no probe to say what it means
 *   mismatch    the CLI ran something other than the expected model
 */

import { cliVersionOf } from './cliCompat.mjs';
import { CLAUDE_ALIASES, splitRuntimePrefix } from './modelRouting.mjs';

const ALIASES = new Set([...CLAUDE_ALIASES, 'default', 'auto', 'inherit-parent']);

/** Trailing tokens that decorate a model id without naming another model. */
const DECORATION = /^(\d{8}|\d+[km]|none|minimal|low|medium|high|xhigh|extra-high|max)$/;

/**
 * `Composer 2.5` → `composer-2-5`, `claude-haiku-4-5-20251001` → `claude-haiku-4-5`,
 * `claude-opus-5-5[effort=high]` → `claude-opus-5-5`, `Claude Opus 5.5 1M High` → `claude-opus-5-5`.
 */
export function normalizeModelId(id) {
  if (id === null || id === undefined) return null;
  const { model } = splitRuntimePrefix(String(id));
  const tokens = model
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
    .split(/[\s_.\-]+/)
    .filter(Boolean);
  // `extra-high` is one tier spread over two tokens.
  while (tokens.length > 1) {
    const last = tokens.at(-1);
    if (last === 'high' && tokens.at(-2) === 'extra') tokens.splice(-2, 2);
    else if (DECORATION.test(last)) tokens.pop();
    else break;
  }
  return tokens.join('-') || null;
}

export function isAlias(slug) {
  const { model } = splitRuntimePrefix(String(slug ?? ''));
  return ALIASES.has(model.trim().toLowerCase());
}

/**
 * A concrete slug is its own expectation. An alias means whatever the last
 * probe saw it run, or nothing when it was never probed.
 *
 * @param {{ runtime: string, model: string }} binding
 * @param {{ probeCache?: Record<string, { effective?: string | null }> }} opts
 */
export function expectedModelFor(binding, { probeCache = {} } = {}) {
  if (!binding?.model) return null;
  if (!isAlias(binding.model)) return binding.model;
  return probeCache[`${binding.runtime}:${binding.model}`]?.effective ?? null;
}

/**
 * @param {{ requested: string, effective?: string | null, expected?: string | null }} input
 * @returns {{ state: 'ok' | 'unverified' | 'mismatch', requested: string, effective: string | null, expected: string | null, note: string }}
 */
export function checkModel({ requested, effective = null, expected = null }) {
  // Records written before expectedModel existed still hold a concrete request.
  const target = expected ?? (isAlias(requested) ? null : requested);
  const base = { requested, effective: effective ?? null, expected: target };
  if (!effective) return { ...base, state: 'unverified', note: 'no evidence' };
  if (!target) return { ...base, state: 'unverified', note: `alias ${requested} resolved to ${effective}` };
  if (normalizeModelId(effective) !== normalizeModelId(target)) {
    return { ...base, state: 'mismatch', note: `expected ${target}, CLI ran ${effective}` };
  }
  return { ...base, state: 'ok', note: `ran ${effective}` };
}

/** `opus → claude-opus-4-8 ⚠ esperado claude-opus-5-5`, `opus → claude-opus-4-8 (alias)`, `composer-2.5`. */
export function modelLabel(check) {
  const { requested, effective, expected, state } = check;
  let label = requested;
  if (effective && normalizeModelId(effective) !== normalizeModelId(requested)) {
    label += ` → ${effective.replace(/-\d{8}$/, '')}`;
  }
  if (state === 'mismatch') label += ` ⚠ esperado ${expected}`;
  else if (state === 'unverified' && effective) label += ' (alias)';
  return label;
}

/** One line the orchestrator reads before it attributes a verdict, or null. */
export function modelWarning(check) {
  if (check?.state !== 'mismatch') return null;
  return `⚠ model mismatch: requested ${check.requested}, the CLI ran ${check.effective}, expected ${check.expected}. Do not attribute this result to ${check.expected}.`;
}

/**
 * The API turns a model away when the CLI is too old for it ("requires Claude
 * Code 2.1.280 or later"). Name the installed CLI so the fix is obvious.
 */
export function cliRejection({ runtime, model, cliVersion, text }) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  const tooOld = /(requires?|needs?|upgrade|update)[^.]{0,80}\b(claude code|cli)\b|\b(claude code|cli)\b[^.]{0,80}(or later|or newer|newer version)/i;
  if (!tooOld.test(flat)) return null;
  const needed = /(\d+\.\d+\.\d+)/.exec(flat)?.[1];
  const parsed = cliVersionOf(cliVersion);
  const installed = parsed ?? String(cliVersion ?? 'unknown version').split(/\s/)[0];
  return `${runtime} CLI ${installed} cannot run ${model}${needed ? `: the API requires ${needed} or later` : ''}. Update the ${runtime} CLI and retry. API said: ${flat.slice(0, 200)}`;
}
