import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './config.mjs';
import {
  bindingsFromSheet,
  defaultSheetTemplate,
  GENERIC_ALIAS_ROLES,
  parseModelSheet,
  sheetBindingOverflowWarnings,
  sheetRowMapsToZedRole,
  zedpstackManagedRoles,
} from './modelSheet.mjs';
import { zedpstackRoot } from './paths.mjs';
import { collectBindingRoutingErrors } from './modelRouting.mjs';
import { workerSheetPath } from './workerModels.mjs';

/** Cursor / IDE pstack override (orchestrator Task slugs). */
export function orchestratorModelSheetPath() {
  const cursor = path.join(os.homedir(), '.cursor', 'rules', 'pstack-models.mdc');
  if (fs.existsSync(cursor)) return cursor;
  const plain = path.join(os.homedir(), '.cursor', 'rules', 'pstack-models.md');
  if (fs.existsSync(plain)) return plain;
  return path.join(os.homedir(), '.zedpstack', 'pstack-models.md');
}

/** Worker spawn sheet. The orchestrator's host sheet is never a fallback: its slugs may not spawn. */
export function workerModelSheetPath() {
  return workerSheetPath();
}

export function defaultModelSheetPath() {
  return workerSheetPath();
}

export function readModelSheet(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, text: defaultSheetTemplate(), exists: false };
  }
  let text = fs.readFileSync(resolved, 'utf8');
  if (resolved.endsWith('.mdc')) {
    text = text.replace(/^---[\s\S]*?---\s*/m, '');
  }
  return { path: resolved, text, exists: true };
}

/**
 * Apply sheet bindings and drop stale zedpstack-managed overrides (preserves unknown roles).
 */
export function reconcileConfigRoles(existingRoles, bindings, rolesAffected, parsed) {
  const roles = { ...(existingRoles ?? {}) };
  const managed = new Set(zedpstackManagedRoles());
  const affected = new Set(rolesAffected);

  for (const [role, binding] of Object.entries(bindings)) {
    roles[role] = binding;
  }

  for (const role of affected) {
    if (!(role in bindings)) {
      delete roles[role];
    }
  }

  for (const role of managed) {
    if (role in bindings || affected.has(role)) continue;
    if (GENERIC_ALIAS_ROLES.has(role) && sheetRowMapsToZedRole(parsed, role)) {
      continue;
    }
    delete roles[role];
  }

  return roles;
}

export function applyModelSheetToConfig({
  sheetPath,
  configPath,
  allowMissingSheet = false,
  dryRun = false,
  strict = false,
} = {}) {
  const resolvedPath = sheetPath ?? defaultModelSheetPath();
  const sheet = readModelSheet(resolvedPath);
  if (!sheet.exists && !allowMissingSheet) {
    throw new Error(
      `Model sheet not found at ${sheet.path}. Run "dispatch setup init" or pass --file.`,
    );
  }
  const parsed = parseModelSheet(sheet.text);
  const { bindings, overflows, rolesAffected, skippedInheritance } =
    bindingsFromSheet(parsed);

  const cfgFile =
    configPath ??
    process.env.ZEDPSTACK_CONFIG ??
    path.join(zedpstackRoot(), 'zedpstack.config.json');

  let configData = { roles: {}, timeouts: {} };
  if (fs.existsSync(cfgFile)) {
    configData = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  }
  const routingErrors = collectBindingRoutingErrors(bindings);
  if (strict && routingErrors.length) {
    const msg = routingErrors.map((e) => e.message).join('\n');
    throw new Error(`setup apply --strict: routing errors:\n${msg}`);
  }

  const previousRoles = configData.roles ?? {};
  const nextRoles = reconcileConfigRoles(
    previousRoles,
    bindings,
    rolesAffected,
    parsed,
  );
  if (!configData.$schema) {
    configData.$schema = './schemas/config.schema.json';
  }

  if (!dryRun) {
    configData.roles = nextRoles;
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, `${JSON.stringify(configData, null, 2)}\n`, 'utf8');
  }

  const rolesRemoved = Object.keys(previousRoles).filter(
    (role) => role in previousRoles && !(role in nextRoles),
  );

  return {
    dryRun,
    strict,
    routingErrors,
    sheetPath: sheet.path,
    sheetExists: sheet.exists,
    orchestratorSheetPath: orchestratorModelSheetPath(),
    workerSheetPath: workerModelSheetPath(),
    configPath: cfgFile,
    rolesPreview: dryRun ? nextRoles : undefined,
    rolesUpdated: Object.keys(bindings),
    rolesAffected,
    rolesRemoved,
    skippedInheritance,
    overflows,
    overflowWarnings: overflows.length
      ? sheetBindingOverflowWarnings(overflows)
      : [],
    defaultEffort: parsed.defaultEffort,
    sessionHook: parsed.sessionHook,
    droppedLines: parsed.droppedLines,
  };
}

export function initModelSheet(filePath) {
  const target = path.resolve(filePath ?? workerSheetPath());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const body = defaultSheetTemplate();
    if (target.endsWith('.mdc')) {
      fs.writeFileSync(
        target,
        `---
description: pstack per-role model choices (zedpstack sync)
alwaysApply: true
---
${body}`,
        'utf8',
      );
    } else {
      fs.writeFileSync(target, body, 'utf8');
    }
  }
  return target;
}

export function roleBindingsFromWorkerSheet(sheetPath = workerModelSheetPath()) {
  const sheet = readModelSheet(sheetPath);
  const parsed = parseModelSheet(sheet.text);
  return bindingsFromSheet(parsed).bindings;
}

/** Sheet bindings override config roles; timeouts and other config fields stay on the base config. */
export function configForRun(config, { sheetPath } = {}) {
  const bindings = roleBindingsFromWorkerSheet(sheetPath);
  const configRoles = config.data.roles ?? {};
  return {
    ...config,
    data: {
      ...config.data,
      roles: { ...configRoles, ...bindings },
    },
  };
}

export function showSetupStatus() {
  const sheet = readModelSheet(defaultModelSheetPath());
  const { path: cfgPath, data } = loadConfig();
  return {
    orchestratorSheet: orchestratorModelSheetPath(),
    workerSheet: workerModelSheetPath(),
    modelSheet: sheet.path,
    modelSheetExists: sheet.exists,
    configPath: cfgPath,
    roleCount: Object.keys(data.roles ?? {}).length,
    roles: data.roles ?? {},
  };
}
