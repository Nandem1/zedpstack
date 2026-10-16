import fs from 'node:fs';
import path from 'node:path';
import { zedpstackRoot } from './paths.mjs';

export function loadConfig() {
  const candidates = [
    process.env.ZEDPSTACK_CONFIG,
    path.join(zedpstackRoot(), 'zedpstack.config.json'),
    path.join(zedpstackRoot(), 'zedpstack.config.local.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      return { path: file, data: JSON.parse(raw) };
    }
  }

  const example = path.join(zedpstackRoot(), 'zedpstack.config.example.json');
  if (fs.existsSync(example)) {
    return { path: example, data: JSON.parse(fs.readFileSync(example, 'utf8')) };
  }

  throw new Error(
    'No zedpstack config found. Copy zedpstack.config.example.json to zedpstack.config.json',
  );
}

/**
 * @returns {import('./types.mjs').RoleBinding}
 */
const ROLE_BINDING_ALIASES = {
  'how-explorer': 'explorer',
  'how-explainer': 'synthesizer',
  'why-investigator': 'explorer',
  'why-synthesizer': 'synthesizer',
  'architect-ground': 'explorer',
  'architect-runner': 'explorer',
  'architect-synthesize': 'synthesizer',
  'interrogate-reviewer': 'explorer',
  'interrogate-lead': 'synthesizer',
  'reflect-reviewer': 'explorer',
  'reflect-synthesize': 'synthesizer',
};

export function resolveRoleBinding(config, role) {
  const roles = config.data.roles ?? {};
  const lookup = roles[role] ? role : ROLE_BINDING_ALIASES[role];
  const binding = lookup ? roles[lookup] : undefined;
  if (!binding?.runtime || !binding?.model || !binding?.permissionProfile) {
    throw new Error(`Missing RoleBinding for role "${role}" in config`);
  }
  return {
    runtime: binding.runtime,
    model: binding.model,
    permissionProfile: binding.permissionProfile,
  };
}

export function resolveTimeout(config, role) {
  const key =
    typeof config.data.timeouts?.[role] === 'number'
      ? role
      : (ROLE_BINDING_ALIASES[role] ?? role);
  const t = config.data.timeouts?.[key];
  return typeof t === 'number' ? t : 600_000;
}
