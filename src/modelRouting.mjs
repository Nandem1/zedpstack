/**
 * Classify model slugs into worker runtimes.
 * Provider (vendor) ≠ transport (which CLI spawns the worker).
 *
 * A slug may carry an explicit runtime prefix, `cursor:claude-opus-5-5` or
 * `codex:gpt-6-sol`, which always wins over inference. Use it when one slug is
 * valid on more than one CLI.
 */

/** @typedef {'claude' | 'codex' | 'cursor'} WorkerRuntime */

export const WORKER_RUNTIMES = ['claude', 'codex', 'cursor'];

const CLAUDE_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);

const RULES = [
  { runtime: 'claude', provider: 'anthropic', re: /^claude-/, reason: 'Anthropic model id for Claude Code CLI' },
  { runtime: 'codex', provider: 'openai', re: /^(gpt-|chatgpt|codex|o[134](-|$))/, reason: 'OpenAI slug for Codex CLI' },
  { runtime: 'codex', provider: 'openai', re: /-(sol|astra|luna)$/, reason: 'OpenAI tier slug for Codex CLI' },
  {
    runtime: 'cursor',
    provider: 'cursor',
    re: /^(composer|cursor-|grok|glm-|gemini-|kimi-|muse-|deepseek-)/,
    reason: 'Cursor Agent CLI slug',
  },
];

/**
 * Split an optional `runtime:` prefix off a slug.
 * @returns {{ runtime: WorkerRuntime | null, model: string }}
 */
export function splitRuntimePrefix(raw) {
  const s = (raw ?? '').trim();
  const idx = s.indexOf(':');
  if (idx > 0) {
    const prefix = s.slice(0, idx).toLowerCase();
    if (WORKER_RUNTIMES.includes(prefix)) {
      return { runtime: prefix, model: s.slice(idx + 1).trim() };
    }
  }
  return { runtime: null, model: s };
}

/**
 * @param {string} raw slug, optionally `runtime:slug` (effort suffix already stripped)
 * @returns {{
 *   runtime: WorkerRuntime,
 *   model: string,
 *   provider: string,
 *   reason: string,
 *   confident: boolean,
 * }}
 */
export function classifyModelSlug(raw) {
  const { runtime: forced, model } = splitRuntimePrefix(raw);
  if (forced) {
    return { runtime: forced, model, provider: 'explicit', reason: `explicit "${forced}:" prefix`, confident: true };
  }
  const lower = model.toLowerCase();
  if (!lower || lower === 'inherit-parent' || lower === 'auto') {
    return { runtime: 'claude', model, provider: 'unknown', reason: 'inheritance placeholder', confident: false };
  }
  if (CLAUDE_ALIASES.has(lower)) {
    return { runtime: 'claude', model, provider: 'anthropic', reason: 'Claude Code CLI alias', confident: true };
  }
  for (const rule of RULES) {
    if (rule.re.test(lower)) {
      return { runtime: rule.runtime, model, provider: rule.provider, reason: rule.reason, confident: true };
    }
  }
  return {
    runtime: 'claude',
    model,
    provider: 'unknown',
    reason: 'unknown slug; defaulted to claude. Prefix it (cursor:, codex:, claude:) to be explicit',
    confident: false,
  };
}

/**
 * @param {string} model
 * @param {WorkerRuntime} runtime
 */
export function validateModelForRuntime(model, runtime) {
  const { runtime: inferred, reason, confident } = classifyModelSlug(model);
  if (inferred === runtime || !confident) {
    return { ok: true, inferred, reason };
  }
  return {
    ok: false,
    inferred,
    reason,
    message: `Model "${model}" belongs on runtime "${inferred}", not "${runtime}". ${reason}`,
  };
}

/**
 * @param {Record<string, { runtime: string, model: string }>} bindings
 */
export function collectBindingRoutingErrors(bindings) {
  const errors = [];
  for (const [role, binding] of Object.entries(bindings ?? {})) {
    if (!binding?.model) continue;
    const check = validateModelForRuntime(binding.model, binding.runtime);
    if (!check.ok) {
      errors.push({ role, model: binding.model, runtime: binding.runtime, ...check });
    }
  }
  return errors;
}
