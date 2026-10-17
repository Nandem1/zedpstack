import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_POLICY } from './auth.mjs';
import { configuredEngine } from './engine.mjs';

function executablePath(command, env) {
  const candidates = command.includes('/') || command.includes('\\')
    ? [path.resolve(command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  return candidates.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  }) ?? null;
}

function npxCache(pkg, env) {
  const match = /^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(pkg);
  if (!match) return null;
  const [, name, version] = match;
  const cache = env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? path.join(env.HOME ?? os.homedir(), '.npm');
  const root = path.join(cache, '_npx');
  let entries;
  try { entries = fs.readdirSync(root); } catch { return null; }
  for (const entry of entries) {
    const dir = path.join(root, entry, 'node_modules', name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (version && manifest.version !== version) continue;
      const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
      if (bin && fs.statSync(path.join(dir, bin)).isFile()) return { path: dir, version: manifest.version };
    } catch {}
  }
  return null;
}

export function inspectEngine(runtime, { env = process.env, ...options } = {}) {
  const resolution = configuredEngine(runtime, { env, ...options });
  const executable = executablePath(resolution.command[0], env);
  const cache = resolution.npxPackage ? npxCache(resolution.npxPackage, env) : null;
  const available = Boolean(executable && (!resolution.npxPackage || cache));
  return {
    ...resolution,
    executable,
    cache,
    available,
    status: !executable ? 'missing-executable' : !available ? 'missing-npx-cache' : 'installed',
    authPolicy: AUTH_POLICY[runtime],
  };
}

export function inspectEngines(options = {}) {
  return Object.fromEntries(Object.keys(AUTH_POLICY).map((runtime) => [runtime, inspectEngine(runtime, options)]));
}
