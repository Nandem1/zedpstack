/**
 * Data behind /setup-zedpstack: effort → which roles to change → model(s).
 * A role takes one model, a panel role takes a multi-select.
 * The orchestrator renders the questions with its host's question tool;
 * this module detects models, builds options, validates and writes the sheet.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAlias } from './modelCheck.mjs';
import { classifyModelSlug } from './modelRouting.mjs';
import { parseModelValue } from './modelSheet.mjs';
import { resolvePstackInstall } from './pstack.mjs';
import { loadWorkerModels, workerSheetPath } from './workerModels.mjs';

export const PROVIDERS = {
  claude: { label: 'Claude', cli: 'claude -p' },
  codex: { label: 'GPT (Codex)', cli: 'codex exec' },
  cursor: { label: 'Cursor', cli: 'agent -p' },
};

/** pstack role rows in sheet order. `panel` rows hold a list. */
export const ROLE_ROWS = [
  { role: 'feature, refactoring', what: 'implementa features y refactors' },
  { role: 'bug-fix', what: 'reproduce y arregla bugs' },
  { role: 'perf-issue', what: 'investiga y mejora rendimiento' },
  { role: 'hillclimb', what: 'mejora una métrica en bucle' },
  { role: 'judgment and prose', what: 'juicio general y redacción' },
  { role: 'strongest judgment', what: 'las decisiones más difíciles' },
  { role: 'how explorer', what: 'explora el código en paralelo (how)' },
  { role: 'how explainer', what: 'sintetiza la explicación (how)' },
  { role: 'why investigators', what: 'investiga el porqué: git, PRs, issues' },
  { role: 'why synthesizer', what: 'sintetiza el porqué (why)' },
  { role: 'reflect tooling', what: 'revisa herramientas de la sesión (reflect)' },
  { role: 'reflect judgment, divergent, synthesizer', what: 'revisores y síntesis de reflect' },
  { role: 'arena runners', what: 'candidatos de arena', panel: true },
  { role: 'arena cross-judge pool', what: 'jueces cruzados de arena', panel: true },
  { role: 'swarm workers', what: 'workers de swarm' },
  { role: 'architect runners', what: 'diseños en paralelo (architect)', panel: true },
  { role: 'interrogate reviewers', what: 'revisores adversariales (interrogate)', panel: true },
];

const ARENA_CHOICE = 'arena runners + cross-judge pool';

/** Four multi-select questions of four options each, one host call. */
export const ROLE_GROUPS = [
  { header: 'Implementar', roles: ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb'] },
  { header: 'Juicio', roles: ['judgment and prose', 'strongest judgment', 'how explainer', 'why synthesizer'] },
  { header: 'Explorar', roles: ['how explorer', 'why investigators', 'reflect tooling', 'swarm workers'] },
  { header: 'Paneles', roles: ['architect runners', 'interrogate reviewers', ARENA_CHOICE, 'reflect judgment, divergent, synthesizer'] },
];

const EFFORT_CHOICES = [
  { label: 'default', value: 'session', description: 'Cada CLI usa su propio effort por defecto (Codex lee model_reasoning_effort de su config).' },
  { label: 'medium', value: 'medium', description: 'Equilibrio entre coste y profundidad.' },
  { label: 'high', value: 'high', description: 'Más razonamiento por llamada; más lento y caro.' },
];

const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

function probeCachePath(env = process.env) {
  return path.join(env.ZEDPSTACK_HOME ?? path.join(os.homedir(), '.zedpstack'), 'model-probe.json');
}

/** Reads the last probes; never probes. */
export function readProbeCache(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(probeCachePath(env), 'utf8'));
  } catch {
    return {};
  }
}

/** One minimal `claude -p` call: is the alias usable, and which model answers. */
function probeClaude(alias, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '--model', alias, '--tools', '', '--output-format', 'stream-json', '--verbose'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      let effective = null;
      let error = null;
      let ok = false;
      for (const line of out.split('\n')) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === 'system' && obj.subtype === 'init') effective = obj.model ?? effective;
        if (obj.type === 'result') {
          ok = !obj.is_error;
          if (obj.is_error) error = String(obj.result ?? obj.subtype ?? 'error').split('\n')[0].slice(0, 160);
        }
      }
      if (!ok && !error) error = out.trim().split('\n').pop()?.slice(0, 160) || 'no response';
      resolve({ ok, effective: effective?.replace(/-\d{8}$/, '') ?? null, error });
    });
    child.stdin.end('Reply with exactly: OK');
  });
}

function claudeAliases() {
  try {
    const file = path.join(resolvePstackInstall().root, 'models.json');
    const available = JSON.parse(fs.readFileSync(file, 'utf8')).available;
    if (Array.isArray(available) && available.length) return available;
  } catch {
    // fall through
  }
  return ['opus', 'fable', 'sonnet', 'haiku'];
}

function codexCatalog() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    return cache.models
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ model: m.slug, name: m.display_name, description: m.description, ok: true }));
  } catch {
    return [];
  }
}

const TIER_RE = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/;

/** `grok-4.7-high-fast` → { family: 'grok-4.7', fast: true, thinking: false } */
function cursorTraits(id) {
  let rest = id;
  const fast = /-fast$/.test(rest);
  rest = rest.replace(/-fast$/, '');
  rest = rest.replace(TIER_RE, '');
  const thinking = /-thinking$/.test(rest) || /-thinking-/.test(id);
  rest = rest.replace(/-thinking$/, '');
  return { family: rest, fast, thinking };
}

/**
 * Every model `agent --list-models` lists, third-party ones included (Grok,
 * Gemini, Claude and GPT through Cursor). Filtering to Composer hid them all.
 */
function cursorCatalog() {
  const res = spawnSync('agent', ['--list-models'], { encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => /^(\S+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?$/.exec(l.trim().replace(/[\u200b-\u200f]/g, '')))
    .filter((m) => m && m[1] !== 'auto')
    .map((m) => ({ model: m[1], name: m[2].trim(), description: m[2].trim(), ok: true, ...cursorTraits(m[1]) }));
}

/** Cursor models grouped by family for the "pick something else" list. */
export function cursorFamilies(models) {
  const byFamily = new Map();
  for (const m of models) {
    if (!byFamily.has(m.family)) byFamily.set(m.family, []);
    byFamily.get(m.family).push(m.model);
  }
  return [...byFamily].map(([family, ids]) => ({ family, models: ids }));
}

/** Best variant of a Cursor family: plain over fast and thinking, high over other tiers. */
function pickCursor(models, familyRe) {
  const pool = models.filter((m) => familyRe.test(m.family));
  const score = (m) => (m.fast ? 4 : 0) + (m.thinking ? 2 : 0) + (/-high$/.test(m.model) || m.model === m.family ? 0 : 1);
  const families = [...new Set(pool.map((m) => m.family))].sort().reverse();
  const newest = pool.filter((m) => m.family === families[0]);
  return newest.sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * Available worker models per provider. Claude aliases are probed (cached a
 * day) because the account, not the CLI, decides whether they run.
 */
export async function detectModels({ refresh = false, extraClaude = [] } = {}) {
  const cache = refresh ? {} : readProbeCache();
  const fresh = (entry) => entry && Date.now() - Date.parse(entry.at) < PROBE_TTL_MS;
  const claudeInstalled = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
  const aliases = claudeInstalled ? [...new Set([...claudeAliases(), ...extraClaude])] : [];
  const probes = await Promise.all(
    aliases.map(async (alias) => {
      const key = `claude:${alias}`;
      if (fresh(cache[key])) return [key, cache[key]];
      return [key, { ...(await probeClaude(alias)), at: new Date().toISOString() }];
    }),
  );
  const nextCache = { ...cache, ...Object.fromEntries(probes) };
  fs.mkdirSync(path.dirname(probeCachePath()), { recursive: true });
  fs.writeFileSync(probeCachePath(), `${JSON.stringify(nextCache, null, 2)}\n`);

  const claude = aliases.map((alias) => {
    const p = nextCache[`claude:${alias}`];
    return { model: alias, name: alias, effective: p.effective, ok: p.ok, error: p.ok ? undefined : p.error };
  });
  return {
    claude,
    codex: spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0 ? codexCatalog() : [],
    cursor: cursorCatalog(),
    probedAt: new Date().toISOString(),
  };
}

function slugFor(runtime, model) {
  return classifyModelSlug(model).runtime === runtime ? model : `${runtime}:${model}`;
}

function availability(models, runtime, model) {
  return models[runtime]?.find((m) => m.model === model) ?? null;
}

/** `claude-opus-5-5-high` typed bare is a Cursor id when its inferred CLI cannot run it. */
function preferCursorWhenOnlyThere(models, raw) {
  const { model, effort } = parseModelValue(raw);
  const routed = classifyModelSlug(model);
  if (/^(claude|codex|cursor):/.test(raw) || availability(models, routed.runtime, routed.model)?.ok) return raw;
  if (!availability(models, 'cursor', routed.model)) return raw;
  return `cursor:${model}${effort ? ` @${effort}` : ''}`;
}

function describeEntry(models, entry) {
  if (entry.inherit) return { value: entry.raw, problem: 'inherit-parent/auto no aplica a un CLI separado; corre el default de pstack' };
  const found = availability(models, entry.runtime, entry.model);
  const out = { value: slugFor(entry.runtime, entry.model), runtime: entry.runtime, model: entry.model };
  if (entry.effort) out.effort = entry.effort;
  if (found?.effective && found.effective !== entry.model) out.effective = found.effective;
  if (out.effective && found.ok && isAlias(entry.model)) out.pin = slugFor(entry.runtime, found.effective);
  if (!found) out.problem = `${entry.model} no aparece entre los modelos de ${PROVIDERS[entry.runtime]?.label ?? entry.runtime}`;
  else if (!found.ok) out.problem = found.error;
  return out;
}

/** An alias names whatever the CLI ships today, so a verdict cannot say which model gave it. */
function pinAdvice({ value, effective, pin }) {
  return `${value} es un alias y hoy corre ${effective}; fija ${pin} (o el id que esperas) para que el rol no cambie de modelo con el CLI`;
}

function modelOption(provider, m, current) {
  const bits = [];
  if (m.effective && m.effective !== m.model) bits.push(`corre ${m.effective}`);
  if (m.description) bits.push(m.description);
  if (current) bits.push('actual');
  return { label: m.model, value: slugFor(provider, m.model), description: bits.join(' · ') || PROVIDERS[provider].cli };
}

/** Everything the orchestrator needs to ask the questions. */
export async function buildSetupPlan({ refresh = false } = {}) {
  const sheet = loadWorkerModels();
  const extraClaude = Object.values(sheet.roles)
    .flatMap((r) => r.entries)
    .filter((e) => !e.inherit && e.runtime === 'claude')
    .map((e) => e.model);
  const models = await detectModels({ refresh, extraClaude });
  const roles = ROLE_ROWS.map((row) => {
    const current = sheet.roles[row.role];
    const entries = current?.entries ?? [];
    const slots = entries.map((e) => describeEntry(models, e));
    return {
      role: row.role,
      what: row.what,
      panel: Boolean(row.panel),
      source: current?.source ?? 'missing',
      slots,
      problems: slots.filter((s) => s.problem).map((s) => `${s.value}: ${s.problem}`),
      recommendations: slots.filter((s) => s.pin).map(pinAdvice),
    };
  });

  const usable = Object.fromEntries(
    Object.keys(PROVIDERS).map((p) => [p, models[p].filter((m) => m.ok)]),
  );
  const first = (p) => usable[p].find((m) => !m.fast) ?? usable[p][0];
  const picks = [
    first('claude') && ['claude', first('claude')],
    first('codex') && ['codex', first('codex')],
    pickCursor(usable.cursor, /^composer/) && ['cursor', pickCursor(usable.cursor, /^composer/)],
    pickCursor(usable.cursor, /grok/) && ['cursor', pickCursor(usable.cursor, /grok/)],
    pickCursor(usable.cursor, /^gemini/) && ['cursor', pickCursor(usable.cursor, /^gemini/)],
  ].filter(Boolean);
  const modelOptions = picks.slice(0, 4).map(([p, m]) => modelOption(p, m));
  const shown = new Set(modelOptions.map((o) => o.value));
  const more = Object.keys(PROVIDERS).flatMap((p) => usable[p].map((m) => slugFor(p, m.model))).filter((v) => !shown.has(v));

  return {
    sheetPath: sheet.sheetPath,
    sheetExists: sheet.sheetExists,
    defaultEffort: sheet.defaultEffort ?? 'session',
    roles,
    problemCount: roles.reduce((n, r) => n + r.problems.length, 0),
    models,
    questions: {
      effort: {
        header: 'Effort',
        question: '¿Qué effort por defecto usan los workers?',
        multiSelect: false,
        options: EFFORT_CHOICES,
      },
      roleGroups: ROLE_GROUPS.map((g) => ({
        header: g.header,
        question: `¿Qué roles de "${g.header}" quieres cambiar?`,
        multiSelect: true,
        options: g.roles.map((role) => {
          const rows = role === ARENA_CHOICE ? roles.filter((r) => r.role.startsWith('arena')) : roles.filter((r) => r.role === role);
          const current = rows[0]?.slots.map((s) => s.value).join(', ') || 'sin valor';
          const problem = rows.some((r) => r.problems.length) ? ' ⚠' : '';
          return { label: role === ARENA_CHOICE ? 'arena' : role, value: role, description: `${current}${problem} · ${rows[0]?.what ?? ''}` };
        }),
      })),
      model: {
        header: 'Modelo',
        multiSelect: false,
        note: 'Para un rol de un solo modelo. Cualquier otro de `more`/`catalog` entra por "Other".',
        options: modelOptions,
      },
      panel: {
        header: 'Panel',
        multiSelect: true,
        note: 'Para roles de panel: cada selección es un worker, el orden y la cantidad definen el panel. Mezcla proveedores.',
        options: modelOptions,
      },
    },
    more,
    catalog: {
      claude: usable.claude.map((m) => m.model),
      codex: usable.codex.map((m) => m.model),
      cursor: cursorFamilies(usable.cursor),
    },
  };
}

function formatSheet({ rows, defaultEffort, extraLines }) {
  const lines = [
    '# zedpstack worker sheet: pstack role lines (as in /setup-pstack), values are worker CLI slugs.',
    '# Written by /setup-zedpstack. A runtime prefix (cursor:, codex:, claude:) forces the CLI.',
    '',
  ];
  for (const { role } of ROLE_ROWS) {
    if (rows[role]?.length) lines.push(`${role}: ${rows[role].join(', ')}`);
  }
  if (extraLines.length) {
    lines.push('', '# batch playbooks only (dispatch run)', ...extraLines);
  }
  lines.push('', `default effort: ${defaultEffort}`, '');
  return lines.join('\n');
}

/**
 * Validate the answers and overwrite the worker sheet (idempotent).
 * @param {{ defaultEffort?: string, roles?: Record<string, string[]>, force?: boolean, dryRun?: boolean }} answers
 */
export async function writeSetup({ defaultEffort, roles = {}, force = false, dryRun = false } = {}) {
  const effort = defaultEffort === 'default' ? 'session' : defaultEffort;
  if (effort && !['session', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`invalid default effort "${defaultEffort}"`);
  }
  const sheet = loadWorkerModels();
  const known = new Set(ROLE_ROWS.map((r) => r.role));
  // Full Claude ids typed through "Other" (claude-opus-5-5) are probed on demand.
  const extraClaude = Object.values(roles)
    .flat()
    .map((raw) => classifyModelSlug(parseModelValue(String(raw)).model))
    .filter((r) => r.runtime === 'claude')
    .map((r) => r.model);
  const models = await detectModels({ extraClaude });
  const expanded = {};
  for (const [role, values] of Object.entries(roles)) {
    const targets = role === ARENA_CHOICE || role === 'arena' ? ['arena runners', 'arena cross-judge pool'] : [role];
    for (const t of targets) {
      if (!known.has(t)) throw new Error(`unknown role "${role}"`);
      expanded[t] = Array.isArray(values) ? values : [values];
    }
  }

  const errors = [];
  const aliasWarnings = [];
  for (const [role, values] of Object.entries(expanded)) {
    expanded[role] = values.map((raw) => preferCursorWhenOnlyThere(models, String(raw)));
    const row = ROLE_ROWS.find((r) => r.role === role);
    if (!values.length) errors.push(`${role}: needs at least one model`);
    if (!row.panel && values.length > 1) errors.push(`${role}: takes one model, got ${values.length}`);
    for (const raw of expanded[role]) {
      const { model, effort: e } = parseModelValue(raw);
      const routed = classifyModelSlug(model);
      const found = availability(models, routed.runtime, routed.model);
      if (!found) errors.push(`${role}: ${raw} is not a detected ${PROVIDERS[routed.runtime].label} model`);
      else if (!found.ok) errors.push(`${role}: ${raw} does not run (${found.error})`);
      else if (isAlias(routed.model) && found.effective && found.effective !== routed.model) {
        aliasWarnings.push(`${role}: ${raw} is an alias the CLI runs as ${found.effective} today; write ${slugFor(routed.runtime, found.effective)} to pin it`);
      }
      if (e && !['low', 'medium', 'high', 'xhigh', 'max'].includes(e)) errors.push(`${role}: bad effort @${e}`);
    }
  }
  if (errors.length && !force) {
    throw new Error(`setup write rejected:\n- ${errors.join('\n- ')}`);
  }

  const rows = {};
  for (const { role } of ROLE_ROWS) {
    if (expanded[role]) rows[role] = expanded[role];
    else if (sheet.roles[role]?.source === 'sheet') rows[role] = sheet.roles[role].entries.map((e) => e.raw);
  }
  const extraLines = Object.entries(sheet.roles)
    .filter(([label, r]) => r.source === 'sheet' && !known.has(label))
    .map(([label, r]) => `${label}: ${r.entries.map((e) => e.raw).join(', ')}`);
  const text = formatSheet({ rows, defaultEffort: effort ?? sheet.defaultEffort ?? 'session', extraLines });

  const target = workerSheetPath();
  const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
  }
  return {
    sheetPath: target,
    written: !dryRun,
    changed: previous !== text,
    warnings: [...errors, ...aliasWarnings],
    sheet: text,
  };
}
