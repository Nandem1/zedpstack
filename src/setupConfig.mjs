import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './config.mjs';
import {
  bindingsFromSheet,
  defaultSheetTemplate,
  parseModelSheet,
} from './modelSheet.mjs';
import { zedpstackRoot } from './paths.mjs';

export function defaultModelSheetPath() {
  const cursor = path.join(os.homedir(), '.cursor', 'rules', 'pstack-models.mdc');
  if (fs.existsSync(cursor)) return cursor;
  const plain = path.join(os.homedir(), '.cursor', 'rules', 'pstack-models.md');
  if (fs.existsSync(plain)) return plain;
  return path.join(os.homedir(), '.zedpstack', 'pstack-models.md');
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
 * Merge sheet bindings into zedpstack.config.json (preserves timeouts / unknown roles).
 */
export function applyModelSheetToConfig({ sheetPath, configPath } = {}) {
  const sheet = readModelSheet(sheetPath ?? process.env.ZEDPSTACK_MODEL_SHEET ?? defaultModelSheetPath());
  const parsed = parseModelSheet(sheet.text);
  const bindings = bindingsFromSheet(parsed);

  const cfgFile =
    configPath ??
    process.env.ZEDPSTACK_CONFIG ??
    path.join(zedpstackRoot(), 'zedpstack.config.json');

  let configData = { roles: {}, timeouts: {} };
  if (fs.existsSync(cfgFile)) {
    configData = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  }
  configData.roles = { ...(configData.roles ?? {}), ...bindings };
  if (!configData.$schema) {
    configData.$schema = './schemas/config.schema.json';
  }

  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, `${JSON.stringify(configData, null, 2)}\n`, 'utf8');

  return {
    sheetPath: sheet.path,
    sheetCreated: !sheet.exists,
    configPath: cfgFile,
    rolesUpdated: Object.keys(bindings),
    defaultEffort: parsed.defaultEffort,
    sessionHook: parsed.sessionHook,
  };
}

export function initModelSheet(filePath) {
  const target = path.resolve(filePath ?? defaultModelSheetPath());
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

export function showSetupStatus() {
  const sheet = readModelSheet(
    process.env.ZEDPSTACK_MODEL_SHEET ?? defaultModelSheetPath(),
  );
  const { path: cfgPath, data } = loadConfig();
  return {
    modelSheet: sheet.path,
    modelSheetExists: sheet.exists,
    configPath: cfgPath,
    roleCount: Object.keys(data.roles ?? {}).length,
    roles: data.roles ?? {},
  };
}
