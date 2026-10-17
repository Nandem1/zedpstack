import { comparePstackVersions } from './pstack.mjs';
import { expectedModelFor, normalizeModelId } from './modelCheck.mjs';
import { RUNTIME_BINARIES } from './permissions.mjs';

/** @type {Record<'claude' | 'codex' | 'cursor', Record<string, { minimum: string, evidence: string }>>} */
const CLI_MINIMUMS = Object.freeze({
  claude: Object.freeze({
    'claude-opus-5-5': Object.freeze({
      minimum: '2.1.280',
      evidence: 'API rejection on 2.1.195, docs/PROBLEMAS_ACTUALES.md, 2026-10-17',
    }),
  }),
  codex: Object.freeze({}),
  cursor: Object.freeze({}),
});

function assertTable(table) {
  const allowed = new Set(Object.keys(RUNTIME_BINARIES));
  for (const runtime of Object.keys(table)) {
    if (!allowed.has(runtime)) {
      throw new Error(`cliCompat: unknown runtime "${runtime}" in CLI_MINIMUMS`);
    }
  }
  for (const runtime of allowed) {
    if (!Object.prototype.hasOwnProperty.call(table, runtime)) {
      throw new Error(`cliCompat: missing runtime "${runtime}" in CLI_MINIMUMS`);
    }
    const models = table[runtime];
    for (const [modelKey, row] of Object.entries(models)) {
      if (!/^[a-z0-9]+(-[a-z0-9.]+)*$/.test(modelKey)) {
        throw new Error(`cliCompat: model key "${modelKey}" is not normalized`);
      }
      if (!row?.evidence?.trim()) {
        throw new Error(`cliCompat: empty evidence for ${runtime}:${modelKey}`);
      }
      if (!cliVersionOf(row.minimum)) {
        throw new Error(`cliCompat: minimum "${row.minimum}" for ${runtime}:${modelKey} is not a version`);
      }
    }
  }
}

assertTable(CLI_MINIMUMS);

/**
 * @param {string | null | undefined} line
 * @returns {string | null}
 */
export function cliVersionOf(line) {
  const token = String(line ?? '').trim().split(/\s/)[0]?.replace(/^v/, '') ?? '';
  return /^\d+(\.\d+)+/.test(token) ? token : null;
}

function isAtLeast(installed, minimum) {
  return comparePstackVersions(installed, minimum) <= 0;
}

/**
 * @param {{ runtime: string, model: string | null, cliVersion: string | null }} input
 * @returns {{ state: string, runtime: string, model: string, minimum: string, evidence: string, installed: string | null, raw?: string } | null}
 */
export function checkCliCompat({ runtime, model, cliVersion }) {
  if (!model) return null;
  const norm = normalizeModelId(model);
  const row = CLI_MINIMUMS[runtime]?.[norm];
  if (!row) return null;
  const base = { runtime, model: norm, minimum: row.minimum, evidence: row.evidence };
  if (cliVersion == null) return { ...base, state: 'missing', installed: null };
  const installed = cliVersionOf(cliVersion);
  if (!installed) return { ...base, state: 'unreadable', installed: null, raw: cliVersion };
  return {
    ...base,
    state: isAtLeast(installed, row.minimum) ? 'ok' : 'below',
    installed,
  };
}

/**
 * @param {{
 *   roles: Record<string, { entries: Array<{ inherit?: boolean, runtime?: string, model?: string }>, source: string }>,
 *   runtimes: Record<string, { bin: string, version: string | null }>,
 *   probeCache: Record<string, { effective?: string | null }>,
 * }} input
 * @returns {{ checks: Array<CliCompat & { roles: string[] }>, problems: string[] }}
 */
export function checkWorkerClis({ roles, runtimes, probeCache }) {
  const rows = new Map();
  for (const [label, { entries }] of Object.entries(roles)) {
    for (const e of entries) {
      if (e.inherit) continue;
      const model = expectedModelFor(e, { probeCache });
      const verdict = checkCliCompat({
        runtime: e.runtime,
        model,
        cliVersion: runtimes[e.runtime]?.version ?? null,
      });
      if (!verdict) continue;
      const key = `${verdict.runtime}:${normalizeModelId(verdict.model)}`;
      const existing = rows.get(key);
      if (existing) {
        if (!existing.roles.includes(label)) existing.roles.push(label);
      } else {
        rows.set(key, { ...verdict, roles: [label] });
      }
    }
  }
  const checks = [...rows.values()];
  const problems = checks
    .filter((c) => c.state === 'below' || c.state === 'unreadable')
    .map(describeCliCompat);
  return { checks, problems };
}

/**
 * @param {CliCompat & { roles?: string[] }} verdict
 * @returns {string}
 */
export function describeCliCompat(verdict) {
  const roleList =
    verdict.roles?.length
      ? ` used by ${verdict.roles.map((r) => `"${r}"`).join(', ')}`
      : '';
  if (verdict.state === 'below') {
    return `${verdict.runtime} CLI ${verdict.installed} is below ${verdict.minimum}, the minimum for ${verdict.model}${roleList}. Update the ${verdict.runtime} CLI.`;
  }
  if (verdict.state === 'unreadable') {
    return `${verdict.model} needs ${verdict.runtime} CLI ${verdict.minimum} or later, but "${verdict.raw}" has no version doctor can read.`;
  }
  return '';
}
