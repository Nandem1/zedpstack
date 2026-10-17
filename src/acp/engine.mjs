import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeer } from './rpc.mjs';

const PINNED = {
  claude: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.93.0'],
  codex: ['npx', '-y', '@agentclientprotocol/codex-acp@2.2.2'],
  cursor: ['cursor-agent', 'acp'],
};

const REGISTRY_RUNTIME_ID = {
  claude: 'claude-acp',
  codex: 'codex-acp',
  cursor: 'cursor',
};

function envEngineOverride(runtime, env) {
  const key = `ZEDPSTACK_ACP_ENGINE_${runtime.toUpperCase()}`;
  const raw = env[key];
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0 || typeof arr[0] !== 'string') return null;
    return arr.map(String);
  } catch {
    return null;
  }
}

function configEngineOverride(runtime, userConfig) {
  const engines = userConfig?.acp?.engines ?? userConfig?.acpEngines;
  const entry = engines?.[runtime];
  if (!entry) return null;
  if (Array.isArray(entry) && entry.length > 0) return entry.map(String);
  if (typeof entry === 'string') return entry.split(/\s+/).filter(Boolean);
  return null;
}

function findRegistryEntry(registry, runtime) {
  if (!registry) return null;
  const id = REGISTRY_RUNTIME_ID[runtime];
  const list = registry.agents ?? registry.entries ?? (Array.isArray(registry) ? registry : []);
  return list.find((a) => a.id === id) ?? null;
}

function resolveFromRegistry(runtime, registry, registryDir, platformArch) {
  const entry = findRegistryEntry(registry, runtime);
  if (!entry?.distribution) return null;

  if (runtime === 'claude' || runtime === 'codex') {
    const pkg = entry.distribution.npx?.package ?? entry.distribution.package;
    if (pkg) return ['npx', '-y', pkg];
  }

  if (runtime === 'cursor') {
    const binaries = entry.distribution.binary ?? {};
    const spec = binaries[platformArch] ?? binaries[Object.keys(binaries)[0]];
    if (!spec?.cmd) return null;
    const versionDir = entry.distribution.path ?? entry.versionPath ?? entry.path;
    let cmd = spec.cmd;
    if (registryDir && versionDir && !path.isAbsolute(cmd)) {
      cmd = path.join(registryDir, '..', 'cursor', versionDir, cmd);
    }
    const args = (spec.args ?? ['acp']).map(String);
    return [cmd, ...args];
  }
  return null;
}

/**
 * @returns {string[]}
 */
export function resolveEngineCommand(
  runtime,
  { env = {}, userConfig = {}, registry = null, registryDir = null, platformArch = `${process.platform}-${process.arch}` } = {},
) {
  const r = String(runtime).toLowerCase();
  return (
    envEngineOverride(r, env) ??
    configEngineOverride(r, userConfig) ??
    resolveFromRegistry(r, registry, registryDir, platformArch) ??
    [...(PINNED[r] ?? PINNED.claude)]
  );
}

function readUserConfig(env) {
  const home = env.ZEDPSTACK_HOME ?? path.join(os.homedir(), '.zedpstack');
  const file = path.join(home, 'config');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function defaultRegistryPath() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Zed',
      'external_agents',
      'registry',
    );
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.local', 'share', 'zed', 'external_agents', 'registry');
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Zed', 'external_agents', 'registry');
}

function loadZedRegistry(registryDir) {
  const dir = registryDir ?? defaultRegistryPath();
  const file = path.join(dir, 'registry.json');
  if (!fs.existsSync(file)) return { registry: null, registryDir: dir };
  try {
    return { registry: JSON.parse(fs.readFileSync(file, 'utf8')), registryDir: dir };
  } catch {
    return { registry: null, registryDir: dir };
  }
}

function prefixStderr(child, label) {
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
}

/**
 * @param {object} opts
 */
export async function startEngine({
  runtime,
  cwd,
  clientCapabilities,
  mcpServers = [],
  env = process.env,
  spawnFn = spawn,
  registryDir = null,
  userConfig = null,
}) {
  const rt = String(runtime).toLowerCase();
  const { registry, registryDir: regDir } = registryDir
    ? { registry: null, registryDir }
    : loadZedRegistry(null);
  let registryData = registry;
  if (!registryData && registryDir) {
    const file = path.join(registryDir, 'registry.json');
    if (fs.existsSync(file)) {
      registryData = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } else if (!registryData) {
    const loaded = loadZedRegistry(null);
    registryData = loaded.registry;
  }

  const cfg = userConfig ?? readUserConfig(env);
  const command = resolveEngineCommand(rt, {
    env,
    userConfig: cfg,
    registry: registryData,
    registryDir: regDir ?? registryDir,
  });

  const child = spawnFn(command[0], command.slice(1), {
    cwd,
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  prefixStderr(child, `acp-engine:${rt}`);

  let dead = false;
  const peer = createPeer({
    input: child.stdout,
    output: child.stdin,
    label: `engine:${rt}`,
  });

  const onDead = () => {
    if (dead) return;
    dead = true;
    peer.close();
    for (const stream of child.stdio) stream?.destroy();
  };
  child.on('exit', onDead);
  child.on('error', onDead);

  let killPromise;
  const kill = () => {
    if (killPromise) return killPromise;
    onDead();
    killPromise = new Promise((resolve) => {
      const pid = child.pid;
      if (!pid) {
        resolve();
        return;
      }

      const signal = (name) => {
        try {
          process.kill(-pid, name);
        } catch {
          try {
            child.kill(name);
          } catch {
            /* */
          }
        }
      };

      if (child.exitCode !== null || child.signalCode !== null) {
        signal('SIGTERM');
        resolve();
        return;
      }

      const timer = setTimeout(() => signal('SIGKILL'), 3000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      signal('SIGTERM');
    });
    return killPromise;
  };

  try {
    const initializeResult = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: clientCapabilities ?? {},
      clientInfo: { name: 'zedpstack' },
    });

    const newSessionResult = await peer.request('session/new', {
      cwd,
      mcpServers,
    });

    return {
      runtime: rt,
      childSessionId: newSessionResult.sessionId,
      peer,
      pid: child.pid,
      initializeResult,
      newSessionResult,
      kill,
      get dead() {
        return dead;
      },
    };
  } catch (error) {
    await kill();
    throw error;
  }
}
