import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZEDPSTACK_VERSION } from '../constants.mjs';
import { mcpScriptPath } from '../paths.mjs';
import { createPeer } from './rpc.mjs';
import { AUTH_POLICY, selectAuthMethod } from './auth.mjs';

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
    if (!path.isAbsolute(cmd) && !versionDir) return null;
    if (registryDir && versionDir && !path.isAbsolute(cmd)) {
      cmd = path.join(registryDir, '..', 'cursor', versionDir, cmd);
    }
    const args = (spec.args ?? ['acp']).map(String);
    return [cmd, ...args];
  }
  return null;
}

export function engineMcpEnv({ env, sessionId, repo, bridgePath = null, parentPid }) {
  const forwarded = Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    value != null && (/^(ZEDPSTACK_|PSTACK_)/.test(name) || name === 'PATH' || name === 'HOME')));
  Object.assign(forwarded, {
    ZEDPSTACK_ACP_SESSION: sessionId,
    ZEDPSTACK_REPO: repo,
    ZEDPSTACK_PARENT_PID: String(parentPid),
  });
  if (bridgePath) forwarded.ZEDPSTACK_ACP_BRIDGE = bridgePath;
  else delete forwarded.ZEDPSTACK_ACP_BRIDGE;
  return Object.entries(forwarded).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * The client's MCP servers plus zedpstack's own, scoped to the outer session so
 * every agent the engine spawns records that session as its origin. The outer id
 * survives runtime switches, the child session id does not.
 */
export function engineMcpServers({ clientServers = [], env = process.env, parentPid = process.pid, ...context }) {
  return [
    ...(clientServers ?? []).filter((server) => server?.name !== 'zedpstack'),
    {
      name: 'zedpstack',
      command: process.execPath,
      args: [mcpScriptPath()],
      env: engineMcpEnv({ env, parentPid, ...context }),
    },
  ];
}

/**
 * @returns {string[]}
 */
export function resolveEngineCommand(
  runtime,
  options = {},
) {
  return resolveEngine(runtime, options).command;
}

export function resolveEngine(
  runtime,
  { env = {}, userConfig = {}, registry = null, registryDir = null, platformArch = `${process.platform}-${process.arch}` } = {},
) {
  const r = String(runtime).toLowerCase();
  if (!Object.hasOwn(PINNED, r)) throw new Error(`unknown ACP runtime: ${runtime}`);
  const candidates = [
    ['env', envEngineOverride(r, env)],
    ['user-config', configEngineOverride(r, userConfig)],
    ['zed-registry', resolveFromRegistry(r, registry, registryDir, platformArch)],
    [r === 'cursor' ? 'path' : 'npx-pin', [...PINNED[r]]],
  ];
  const [source, command] = candidates.find(([, command]) => command);
  const npxPackage = /^npx(?:\.cmd)?$/.test(path.basename(command[0]))
    ? command.slice(1).find((arg) => !arg.startsWith('-')) ?? null : null;
  const version = npxPackage?.match(/.+@([^@]+)$/)?.[1]
    ?? (source === 'zed-registry' ? findRegistryEntry(registry, r)?.version ?? null : null);
  return { command, source, version, npxPackage };
}

function readUserConfig(env) {
  const home = env.ZEDPSTACK_HOME ?? path.join(env.HOME ?? os.homedir(), '.zedpstack');
  const file = path.join(home, 'config');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function defaultRegistryPath(env = process.env) {
  const home = env.HOME ?? os.homedir();
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Zed',
      'external_agents',
      'registry',
    );
  }
  if (process.platform === 'linux') {
    return path.join(home, '.local', 'share', 'zed', 'external_agents', 'registry');
  }
  return path.join(home, 'AppData', 'Roaming', 'Zed', 'external_agents', 'registry');
}

function loadZedRegistry(registryDir, env) {
  const dir = registryDir ?? defaultRegistryPath(env);
  const file = path.join(dir, 'registry.json');
  if (!fs.existsSync(file)) return { registry: null, registryDir: dir };
  try {
    return { registry: JSON.parse(fs.readFileSync(file, 'utf8')), registryDir: dir };
  } catch {
    return { registry: null, registryDir: dir };
  }
}

export function configuredEngine(runtime, { env = process.env, userConfig = null, registryDir = null, ...options } = {}) {
  const loaded = loadZedRegistry(registryDir, env);
  return resolveEngine(runtime, { env, userConfig: userConfig ?? readUserConfig(env), ...loaded, ...options });
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
  handshakeTimeoutMs = 30_000,
}) {
  const rt = String(runtime).toLowerCase();
  const { command } = configuredEngine(rt, { env, userConfig, registryDir });

  const child = spawnFn(command[0], command.slice(1), {
    cwd,
    // Its own group means a SIGKILLed hub cannot take it down; the pid lets it notice instead.
    env: { ...env, ZEDPSTACK_PARENT_PID: String(process.pid) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
    process.stderr.write(`[acp-engine:${rt}] ${chunk}`);
  });

  let dead = false;
  const peer = createPeer({
    input: child.stdout,
    output: child.stdin,
    label: `engine:${rt}`,
  });
  let initialCommands = [];
  peer.onNotification((method, params) => {
    const update = params.update ?? params;
    if (method === 'session/update' && update.sessionUpdate === 'available_commands_update') {
      initialCommands = update.availableCommands ?? [];
    }
  });

  const onDead = (reason) => {
    if (dead) return;
    dead = true;
    peer.close(reason);
  };
  let terminationError;
  let exitStatus = { code: null, signal: null };
  child.on('exit', (code, signal) => {
    exitStatus = { code, signal };
    terminationError = new Error(`child exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
    onDead(terminationError);
  });
  child.on('error', (error) => {
    terminationError = error;
    onDead(error);
  });
  child.stdin.on('error', onDead);
  let childClosed = false;
  const closed = new Promise((resolve) => child.once('close', () => {
    childClosed = true;
    for (const stream of child.stdio) stream?.destroy();
    resolve(exitStatus);
  }));

  let killPromise;
  const kill = () => {
    if (killPromise) return killPromise;
    onDead();
    killPromise = (async () => {
      const pid = child.pid;
      if (!pid) {
        for (const stream of child.stdio) stream?.destroy();
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

      const groupAlive = () => {
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          return error.code === 'EPERM';
        }
      };

      const deadline = Date.now() + 3000;
      const timer = childClosed ? null : setTimeout(() => signal('SIGKILL'), 3000);
      timer?.unref();
      child.stdin?.end();
      signal('SIGTERM');
      await closed;
      clearTimeout(timer);
      // npx exits before the agent it launched, so the rest of the group gets what is left of the 3 s.
      while (groupAlive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (groupAlive()) signal('SIGKILL');
    })();
    return killPromise;
  };

  let stage = 'initialize';
  let timer;
  const handshake = async () => {
    const initializeResult = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: clientCapabilities ?? {},
      clientInfo: { name: 'zedpstack', version: ZEDPSTACK_VERSION },
    });

    const methods = initializeResult.authMethods ?? [];
    if (methods.length) {
      stage = 'authenticate';
      const method = selectAuthMethod(rt, methods, env);
      process.stderr.write(`[acp-engine:${rt}] authenticate ${method.id}\n`);
      await peer.request('authenticate', { methodId: method.id });
    }

    stage = 'session/new';
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
      get initialCommands() {
        return initialCommands;
      },
      kill,
      /** Resolves with `{code, signal}` once the process exited and its pipes closed. */
      exited: closed,
      stderrTail: (lines) => stderr.trim().split('\n').slice(-lines).join('\n'),
      get dead() {
        return dead;
      },
    };
  };

  try {
    return await Promise.race([
      handshake(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`handshake timed out after ${handshakeTimeoutMs} ms`)), handshakeTimeoutMs);
      }),
    ]);
  } catch (error) {
    await kill();
    let reason = /(?:stream )?closed$/.test(error.message) && terminationError
      ? terminationError.message
      : error.message;
    if (typeof error.data?.message === 'string') reason += `: ${error.data.message}`;
    const tail = stderr.trim().split('\n').slice(-10).join('\n');
    throw new Error(
      `engine:${rt}: ${stage} failed: ${reason}`
        + (tail ? `\nstderr:\n${tail}` : '')
        + (AUTH_POLICY[rt] ? `\n${AUTH_POLICY[rt].hint}` : ''),
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
