import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ZEDPSTACK_VERSION } from './constants.mjs';
import { planInstall } from './install.mjs';
import { detectOrchestratorHost } from './orchestratorHost.mjs';
import { RUNTIME_BINARIES } from './permissions.mjs';
import { resolvePstackInstall } from './pstack.mjs';
import { orchestratorModelSheetPath } from './setupConfig.mjs';
import { readProbeCache } from './setupWizard.mjs';
import { describeWorkerModels, loadWorkerModels } from './workerModels.mjs';

function probeRuntimes() {
  const out = {};
  for (const [runtime, bin] of Object.entries(RUNTIME_BINARIES)) {
    const res = spawnSync(bin, [runtime === 'cursor' ? '-v' : '--version'], { encoding: 'utf8' });
    out[runtime] = res.status === 0 ? { bin, version: (res.stdout || res.stderr).trim().split('\n')[0] } : { bin, version: null };
  }
  return out;
}

/** One picture of everything that has to line up for spawn_agent to work. */
export function buildDoctorReport() {
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

  const hosts = planInstall().map(({ host, actions }) => ({
    host,
    ready: actions.every((a) => a.state === 'ok'),
    actions: actions.map(({ apply, ...rest }) => rest),
  }));

  const hostSheet = orchestratorModelSheetPath();
  return {
    version: ZEDPSTACK_VERSION,
    orchestratorHost: detectOrchestratorHost(),
    pstack: pstack ? { root: pstack.root, version: pstack.version } : null,
    runtimes,
    workerSheet,
    hostSheet: { path: hostSheet, exists: fs.existsSync(hostSheet), note: 'read by the orchestrator host only; never used to spawn workers' },
    hosts,
    problems,
  };
}

export function formatDoctorReport(r) {
  const lines = [`zedpstack ${r.version} · orchestrator: ${r.orchestratorHost.id} (${r.orchestratorHost.note})`, ''];
  lines.push(`pstack: ${r.pstack ? `${r.pstack.version} at ${r.pstack.root}` : 'NOT FOUND'}`);
  lines.push('Worker CLIs:');
  for (const [runtime, { bin, version }] of Object.entries(r.runtimes)) {
    lines.push(`  ${runtime.padEnd(7)} ${bin.padEnd(7)} ${version ?? 'missing'}`);
  }
  lines.push('', `Worker sheet: ${r.workerSheet.sheetPath} (${r.workerSheet.sheetExists ? 'found' : 'missing'})`);
  for (const [label, { source, slots }] of Object.entries(r.workerSheet.roles)) {
    const shown = slots.map((s) => (s.inherit ? s.value : `${s.runtime}:${s.model}${s.effort ? ` @${s.effort}` : ''}`)).join(', ');
    lines.push(`  ${label}: ${shown}${source === 'sheet' ? '' : '  (pstack default)'}`);
  }
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
