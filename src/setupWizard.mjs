/**
 * Data behind /setup-zedpstack, shaped like /setup-pstack's question flow:
 * effort → current roles → which roles to change → provider → model.
 * The orchestrator renders the questions with its host's question tool;
 * this module detects models, builds options, validates and writes the sheet.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function probeCachePath() {
  return path.join(process.env.ZEDPSTACK_HOME ?? path.join(os.homedir(), '.zedpstack'), 'model-probe.json');
}

export function readProbeCache() {
  try {
    return JSON.parse(fs.readFileSync(probeCachePath(), 'utf8'));
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

/** Cursor first-party models only (Composer); third-party models run on their own CLIs. */
function cursorCatalog() {
  const res = spawnSync('agent', ['--list-models'], { encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => /^(\S+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?$/.exec(l.trim()))
    .filter((m) => m && /^composer/.test(m[1]))
    .map((m) => ({ model: m[1], name: m[2], description: 'Modelo propio de Cursor', ok: true }));
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

function describeEntry(models, entry) {
  if (entry.inherit) return { value: entry.raw, problem: 'inherit-parent/auto no aplica a un CLI separado; corre el default de pstack' };
  const found = availability(models, entry.runtime, entry.model);
  const out = { value: slugFor(entry.runtime, entry.model), runtime: entry.runtime, model: entry.model };
  if (entry.effort) out.effort = entry.effort;
  if (found?.effective && found.effective !== entry.model) out.effective = found.effective;
  if (!found) out.problem = `${entry.model} no aparece entre los modelos de ${PROVIDERS[entry.runtime]?.label ?? entry.runtime}`;
  else if (!found.ok) out.problem = found.error;
  return out;
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
    };
  });

  const usable = Object.fromEntries(
    Object.keys(PROVIDERS).map((p) => [p, models[p].filter((m) => m.ok)]),
  );
  const providerOptions = Object.entries(PROVIDERS)
    .filter(([p]) => usable[p].length)
    .map(([p, { label, cli }]) => ({
      label,
      value: p,
      description: `${usable[p].map((m) => m.model).slice(0, 4).join(', ')}${usable[p].length > 4 ? ', …' : ''} · ${cli}`,
    }));

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
      change: {
        header: 'Cambios',
        question: '¿Quieres cambiar el modelo de algún rol?',
        multiSelect: false,
        options: [
          { label: 'Mantener', value: 'keep', description: 'Dejar los roles como están' },
          { label: 'Cambiar roles', value: 'change', description: 'Elegir qué roles cambiar' },
        ],
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
      provider: { header: 'Proveedor', multiSelect: false, options: providerOptions },
      models: Object.fromEntries(
        Object.keys(PROVIDERS).map((p) => [
          p,
          {
            header: 'Modelo',
            multiSelect: false,
            options: usable[p].slice(0, 4).map((m) => modelOption(p, m)),
            more: usable[p].slice(4).map((m) => m.model),
          },
        ]),
      ),
      panel: {
        header: 'Panel',
        multiSelect: true,
        note: 'Una entrada por worker: el orden y la cantidad definen el panel. Mezcla proveedores para tener diversidad.',
        options: Object.keys(PROVIDERS)
          .flatMap((p, i) => usable[p].slice(0, i === 1 ? 2 : 1).map((m) => modelOption(p, m)))
          .slice(0, 4),
      },
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
  for (const [role, values] of Object.entries(expanded)) {
    const row = ROLE_ROWS.find((r) => r.role === role);
    if (!values.length) errors.push(`${role}: needs at least one model`);
    if (!row.panel && values.length > 1) errors.push(`${role}: takes one model, got ${values.length}`);
    for (const raw of values) {
      const { model, effort: e } = parseModelValue(raw);
      const routed = classifyModelSlug(model);
      const found = availability(models, routed.runtime, routed.model);
      if (!found) errors.push(`${role}: ${raw} is not a detected ${PROVIDERS[routed.runtime].label} model`);
      else if (!found.ok) errors.push(`${role}: ${raw} does not run (${found.error})`);
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
    warnings: errors,
    sheet: text,
  };
}
