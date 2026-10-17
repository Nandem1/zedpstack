/**
 * Classify pstack model slugs into worker runtimes.
 * Provider (vendor) ≠ transport (which CLI spawns the worker).
 */

/** @typedef {'claude' | 'codex' | 'cursor'} WorkerRuntime */

const CURSOR_SLUG_RE =
  /^(composer|cursor-|grok|glm-|claude-haiku-5-5-thinking|claude-opus-5-5|gpt-5\.|muse-|gemini-|fable-)/i;

const CODEX_SLUG_RE =
  /^(gpt-|chatgpt|o[34]|codex)/i;

const ANTHROPIC_CLAUDE_CLI_RE =
  /^(haiku|sonnet|opus|claude-)/i;

/**
 * @param {string} model raw slug (effort suffix already stripped)
 * @returns {{
 *   runtime: WorkerRuntime,
 *   provider: 'anthropic' | 'openai' | 'cursor' | 'xai' | 'google' | 'unknown',
 *   reason: string,
 * }}
 */
export function classifyModelSlug(model) {
  const s = (model ?? '').trim();
  if (!s || s === 'inherit-parent' || s === 'auto') {
    return { runtime: 'claude', provider: 'unknown', reason: 'inheritance placeholder' };
  }

  const lower = s.toLowerCase();

  if (CURSOR_SLUG_RE.test(lower) || lower.includes('cursor-grok') || lower.includes('composer')) {
    return {
      runtime: 'cursor',
      provider: 'cursor',
      reason: 'Cursor-only slug (composer / grok / glm / panel models)',
    };
  }

  if (CODEX_SLUG_RE.test(lower) || lower.includes('-sol')) {
    return {
      runtime: 'codex',
      provider: 'openai',
      reason: 'OpenAI / Codex slug',
    };
  }

  if (ANTHROPIC_CLAUDE_CLI_RE.test(lower)) {
    return {
      runtime: 'claude',
      provider: 'anthropic',
      reason: 'Anthropic slug for Claude Code CLI',
    };
  }

  return {
    runtime: 'claude',
    provider: 'unknown',
    reason: 'default runtime claude; verify with claude -p --model',
  };
}

/**
 * @param {string} model
 * @param {WorkerRuntime} runtime
 */
export function validateModelForRuntime(model, runtime) {
  const { runtime: inferred, reason } = classifyModelSlug(model);
  if (inferred === runtime) {
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
