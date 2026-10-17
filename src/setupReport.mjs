import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ZEDPSTACK_VERSION } from './constants.mjs';
import { findSessionRepoFromCwd, readDenialAudit, readSession } from './guard.mjs';
import { guardEditsHookState, planInstall } from './install.mjs';
import { detectOrchestratorHost } from './orchestratorHost.mjs';
import { RUNTIME_BINARIES } from './permissions.mjs';
import { resolvePstackInstall } from './pstack.mjs';
import { orchestratorModelSheetPath } from './setupConfig.mjs';
import { readProbeCache } from './setupWizard.mjs';
import { describeWorkerModels, loadWorkerModels } from './workerModels.mjs';
import { inspectEngines } from './acp/diagnostics.mjs';
import { checkWorkerClis } from './cliCompat.mjs';

function probeRuntimes() {
  const out = {};
  for (const [runtime, bin] of Object.entries(RUNTIME_BINARIES)) {
    const res = spawnSync(bin, [runtime === 'cursor' ? '-v' : '--version'], { encoding: 'utf8' });
    out[runtime] = res.status === 0 ? { bin, version: (res.stdout || res.stderr).trim().split('\n')[0] } : { bin, version: null };
  }
  return out;
}

function orchestratorEditGuardReport(home = os.homedir()) {
  const hook = guardEditsHookState(home);
  const sessionRepo = findSessionRepoFromCwd(process.cwd());
  const session = sessionRepo ? readSession(sessionRepo) : null;
  const audit = sessionRepo ? readDenialAudit(sessionRepo) : { count: 0, last: null };
  return {
    hookRegistered: hook === 'ok',
    hookState: hook,
    sessionActive: Boolean(session),
    sessionRepo,
    editsAllowed: Boolean(session?.editsAllowed),
    denials: audit,
  };
}

/** One picture of everything that has to line up for spawn_agent to work. */
export function buildDoctorReport({ home = os.homedir() } = {}) {
  const problems = [];
  let pstack = null;
  try {
    pstack = resolvePstackInstall();
  } catch (err) {
    problems.push(err.message);
  }

  const runtimes = probeRuntimes();
  const models = loadWorkerModels();
  const workerSheet = describeWorkerModels(models);
  if (!models.sheetExists) {
    problems.push(`worker sheet missing (${models.sheetPath}); roles fall back to pstack defaults. Run /setup-zedpstack or "dispatch setup init"`);
  }
  const probes = readProbeCache();
  for (const [label, { entries, source }] of Object.entries(models.roles)) {
    for (const e of entries) {
      if (e.inherit) continue;
      const probe = probes[`${e.runtime}:${e.model}`];
      if (probe && !probe.ok) {
        problems.push(`"${label}"${source === 'sheet' ? '' : ' (pstack default)'} uses ${e.model}, which does not run (${probe.error.replace(/\.$/, "")}). Run /setup-zedpstack`);
      }
      if (source !== 'sheet') continue;
      if (!runtimes[e.runtime]?.version) problems.push(`"${label}" uses ${e.runtime}:${e.model} but the ${RUNTIME_BINARIES[e.runtime]} CLI is not installed`);
      if (!e.confident) problems.push(`"${label}" slug "${e.model}" is unrecognized; prefix it with claude:, codex: or cursor:`);
    }
  }

  const cliCompat = checkWorkerClis({ roles: models.roles, runtimes, probeCache: probes });
  problems.push(...cliCompat.problems);

  const orchestratorEditGuard = orchestratorEditGuardReport(home);

  const hosts = planInstall({ home }).map(({ host, actions }) => ({
    host,
    ready: actions.every((a) => a.state === 'ok'),
    actions: actions.map(({ apply, ...rest }) => rest),
  }));

  const hostSheet = orchestratorModelSheetPath();
  const acp = inspectEngines();
  for (const [runtime, engine] of Object.entries(acp)) {
    if (!engine.available) problems.push(`ACP ${runtime}: no instalado (${engine.status}). ${engine.authPolicy.hint}`);
  }
  return {
    version: ZEDPSTACK_VERSION,
    orchestratorHost: detectOrchestratorHost(),
    pstack: pstack ? { root: pstack.root, version: pstack.version } : null,
    runtimes,
    cliCompat: cliCompat.checks,
    acp,
    workerSheet,
    hostSheet: { path: hostSheet, exists: fs.existsSync(hostSheet), note: 'read by the orchestrator host only; never used to spawn workers' },
    hosts,
    orchestratorEditGuard,
    problems,
  };
}

export function formatDoctorReport(r) {
  const lines = [`zedpstack ${r.version} · orchestrator: ${r.orchestratorHost.id} (${r.orchestratorHost.note})`, ''];
  lines.push(`pstack: ${r.pstack ? `${r.pstack.version} at ${r.pstack.root}` : 'NOT FOUND'}`);
  lines.push('Worker CLIs:');
  for (const [runtime, { bin, version }] of Object.entries(r.runtimes)) {
    lines.push(`  ${runtime.padEnd(7)} ${bin.padEnd(7)} ${version ?? 'missing'}`);
    for (const row of r.cliCompat ?? []) {
      if (row.runtime !== runtime || row.state === 'ok') continue;
      if (row.state === 'below') {
        lines.push(`          below minimum: ${row.model} needs ${row.minimum} (${row.roles.join(', ')})`);
      } else if (row.state === 'unreadable') {
        lines.push(`          version unreadable: ${row.model} needs ${row.minimum}`);
      }
    }
  }
  lines.push('', 'ACP engines (local check, no network):');
  for (const [runtime, engine] of Object.entries(r.acp)) {
    lines.push(
      `  ${runtime}: ${engine.available ? 'installed' : 'MISSING (no instalado)'} [${engine.source}] ${engine.command.map((arg) => JSON.stringify(arg)).join(' ')}`,
      `    version: ${engine.version ?? engine.cache?.version ?? 'unknown'}; executable: ${engine.executable ?? 'missing'}; npx cache: ${engine.npxPackage ? engine.cache?.path ?? 'missing' : 'n/a'}`,
      `    auth: ${engine.authPolicy.methods.map((method) => `${method.id} (${method.credentials})`).join(' -> ')}; ${engine.authPolicy.hint}`,
    );
  }
  lines.push('', `Worker sheet: ${r.workerSheet.sheetPath} (${r.workerSheet.sheetExists ? 'found' : 'missing'})`);
  for (const [label, { source, slots }] of Object.entries(r.workerSheet.roles)) {
    const shown = slots.map((s) => (s.inherit ? s.value : `${s.runtime}:${s.model}${s.effort ? ` @${s.effort}` : ''}`)).join(', ');
    lines.push(`  ${label}: ${shown}${source === 'sheet' ? '' : '  (pstack default)'}`);
  }
  const g = r.orchestratorEditGuard;
  lines.push(
    '',
    'Orchestrator edit guard:',
    `  hook: ${g.hookRegistered ? 'registered' : g.hookState}`,
    `  session: ${g.sessionActive ? `active (${g.sessionRepo})${g.editsAllowed ? ', edits allowed' : ''}` : 'none'}`,
    `  denials: ${g.denials.count}${g.denials.last ? ` (last ${g.denials.last.ts} ${g.denials.last.tool} ${g.denials.last.path})` : ''}`,
  );
  lines.push('', 'Hosts:');
  for (const h of r.hosts) {
    const states = h.actions.map((a) => `${a.kind} ${a.state}`).join(', ');
    lines.push(`  ${h.host.padEnd(11)} ${h.ready ? 'ready' : 'not ready'} (${states})`);
  }
  if (!r.hosts.every((h) => h.ready)) lines.push('  → dispatch install --host <host> --apply');
  lines.push('', r.problems.length ? 'Problems:' : 'No problems found.');
  for (const p of r.problems) lines.push(`  - ${p}`);
  return lines.join('\n');
}
