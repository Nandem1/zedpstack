import { classifyModelSlug } from './modelRouting.mjs';
import {
  bindingsFromSheet,
  parseModelSheet,
  SHEET_TO_ZEDPSTACK_ROLES,
} from './modelSheet.mjs';
import { loadConfig } from './config.mjs';
import {
  orchestratorModelSheetPath,
  readModelSheet,
  workerModelSheetPath,
} from './setupConfig.mjs';
import { detectOrchestratorHost } from './orchestratorHost.mjs';

function sheetRolePreview(parsed) {
  const rows = [];
  for (const [sheetRole, models] of Object.entries(parsed.roles)) {
    const zedRoles = SHEET_TO_ZEDPSTACK_ROLES[sheetRole];
    if (!zedRoles?.length) continue;
    for (const raw of models) {
      const model = raw.split('@')[0].trim();
      const { runtime, provider, reason } = classifyModelSlug(model);
      rows.push({
        sheetRole,
        model: raw,
        zedRoles,
        inferredRuntime: runtime,
        provider,
        reason,
      });
    }
  }
  return rows;
}

/**
 * Full setup picture for orchestrator + workers (pstack-style: show, then user decides).
 */
export function buildSetupDiagnosis() {
  const orchestratorPath = orchestratorModelSheetPath();
  const workerPath = workerModelSheetPath();
  const orchestratorSheet = readModelSheet(orchestratorPath);
  const workerSheet = readModelSheet(workerPath);
  const orchestratorParsed = parseModelSheet(orchestratorSheet.text);
  const workerParsed = workerSheet.exists ? parseModelSheet(workerSheet.text) : null;

  const workerBindings = workerParsed
    ? bindingsFromSheet(workerParsed).bindings
    : {};
  const orchestratorBindings = bindingsFromSheet(orchestratorParsed).bindings;

  const { path: cfgPath, data: configData } = loadConfig();
  const configRoles = configData.roles ?? {};

  const orchestratorPreview = sheetRolePreview(orchestratorParsed);
  const cursorOnlyOnOrchestrator = orchestratorPreview.filter(
    (r) => r.inferredRuntime === 'cursor',
  );

  const blindApplyErrors = [];
  for (const [role, binding] of Object.entries(orchestratorBindings)) {
    const { runtime: inferred } = classifyModelSlug(binding.model);
    if (inferred === 'cursor' && binding.runtime === 'claude') {
      blindApplyErrors.push({
        role,
        model: binding.model,
        issue: 'legacy_inferRuntime_would_spawn_claude',
        fix: `runtime should be "cursor" (Cursor agent CLI)`,
      });
    }
  }

  const workerSheetMissing = !workerSheet.exists;
  const usingSeparateWorkerSheet = workerSheet.exists && workerPath !== orchestratorPath;

  return {
    orchestratorHost: detectOrchestratorHost(),
    orchestratorSheet: {
      path: orchestratorSheet.path,
      exists: orchestratorSheet.exists,
      preview: orchestratorPreview,
      cursorOnlySlugs: cursorOnlyOnOrchestrator,
    },
    workerSheet: {
      path: workerSheet.path,
      exists: workerSheet.exists,
      separateFromOrchestrator: usingSeparateWorkerSheet,
      proposedBindings: workerBindings,
    },
    config: {
      path: cfgPath,
      roleCount: Object.keys(configRoles).length,
      roles: configRoles,
    },
    risks: {
      blindCopyFromCursorMdc: blindApplyErrors,
      workerSheetMissing,
      recommendation: workerSheetMissing
        ? 'Run: dispatch setup init --file ~/.zedpstack/pstack-models.md then edit worker rows (CLI-safe). Do not apply from Cursor mdc alone.'
        : usingSeparateWorkerSheet
          ? 'Apply worker sheet only: ZEDPSTACK_MODEL_SHEET or dispatch setup apply --file ~/.zedpstack/pstack-models.md'
          : 'Orchestrator and worker share one sheet path; consider splitting for Cursor-only slugs.',
    },
  };
}

export function formatSetupDiagnosisHuman(report) {
  const lines = [];
  lines.push('## zedpstack setup');
  lines.push('');
  lines.push(`Orchestrator host (detected): **${report.orchestratorHost.id}** (${report.orchestratorHost.note})`);
  lines.push('');
  lines.push('### Hoja del orquestador (pstack / IDE)');
  lines.push(`- Path: \`${report.orchestratorSheet.path}\` (${report.orchestratorSheet.exists ? 'exists' : 'missing'})`);
  if (report.orchestratorSheet.cursorOnlySlugs.length) {
    lines.push('- Slugs **solo Cursor agent** (no Claude CLI):');
    for (const row of report.orchestratorSheet.cursorOnlySlugs.slice(0, 12)) {
      lines.push(`  - ${row.sheetRole}: \`${row.model}\` → runtime **cursor**`);
    }
  }
  lines.push('');
  lines.push('### Hoja de workers (dispatch spawn)');
  lines.push(`- Path: \`${report.workerSheet.path}\` (${report.workerSheet.exists ? 'exists' : 'missing'})`);
  if (report.workerSheet.separateFromOrchestrator) {
    lines.push('- Separada del orquestador: **sí** (recomendado con Cursor + Zed ACP)');
  }
  lines.push('');
  lines.push('### Config activa');
  lines.push(`- \`${report.config.path}\` — ${report.config.roleCount} roles`);
  lines.push('');
  if (report.risks.blindCopyFromCursorMdc.length) {
    lines.push('### ⚠ Si aplicaras la hoja Cursor sin routing');
    for (const e of report.risks.blindCopyFromCursorMdc.slice(0, 8)) {
      lines.push(`- ${e.role}: \`${e.model}\` — ${e.fix}`);
    }
    lines.push('');
  }
  lines.push(`### Siguiente paso sugerido`);
  lines.push(report.risks.recommendation);
  return lines.join('\n');
}
