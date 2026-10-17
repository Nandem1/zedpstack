import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const ZP_RUNTIME_ID = 'zp.runtime';

const RUNTIME_NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

/**
 * @param {string} current
 * @param {string[]} installed
 */
export function runtimeOption(current, installed = ['claude', 'codex', 'cursor']) {
  return {
    id: ZP_RUNTIME_ID,
    name: 'Orchestrator',
    category: '_zedpstack',
    type: 'select',
    currentValue: current,
    options: Object.entries(RUNTIME_NAMES).map(([value, name]) => ({
      value, name, ...(!installed.includes(value) ? { description: '(no instalado)' } : {}),
    })),
  };
}

export function optionValues(option) {
  return (option?.options ?? []).flatMap((choice) => choice.options ?? [choice]).map((choice) => choice.value);
}

export function isOptionValueValid(option, value) {
  if (option?.type === 'boolean') return typeof value === 'boolean';
  return option?.type === 'select' && optionValues(option).includes(value);
}

export function mergeOptions(zpOption, childOptions = []) {
  const rest = (childOptions ?? []).filter((o) => o?.id !== ZP_RUNTIME_ID);
  return [zpOption, ...rest];
}

export function childOptionState(result = {}) {
  if (result.configOptions != null) return { configOptions: result.configOptions, legacyRoutes: {} };
  const configOptions = [];
  const legacyRoutes = {};
  if (result.models) {
    configOptions.push({
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: result.models.currentModelId,
      options: result.models.availableModels.map(({ modelId, name }) => ({ value: modelId, name })),
    });
    legacyRoutes.model = { method: 'session/set_model', valueKey: 'modelId' };
  }
  if (result.modes) {
    configOptions.push({
      id: 'mode', name: 'Mode', category: 'mode', type: 'select',
      currentValue: result.modes.currentModeId,
      options: result.modes.availableModes.map(({ id, ...option }) => ({ value: id, ...option })),
    });
    legacyRoutes.mode = { method: 'session/set_mode', valueKey: 'modeId' };
  }
  return { configOptions, legacyRoutes };
}

export function routeOption(configId) {
  if (configId === ZP_RUNTIME_ID) return 'hub';
  return 'child';
}

const HUB_COMMANDS = [
  { name: 'claude', description: 'Orquestador con Claude ACP' },
  { name: 'codex', description: 'Orquestador con Codex ACP' },
  { name: 'cursor', description: 'Orquestador con Cursor ACP' },
  { name: 'board', description: 'Tablero de agentes recientes' },
  {
    name: 'edits',
    description: 'Permite (on) o bloquea (off) que el orquestador edite el repo directamente en este hilo',
    input: { hint: 'on | off' },
  },
];

export function mergeCommands(childCommands = []) {
  const seen = new Set();
  return [...HUB_COMMANDS, ...(childCommands ?? [])].filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

export function zedpstackHome(env = process.env) {
  return env.ZEDPSTACK_HOME ?? path.join(env.HOME ?? os.homedir(), '.zedpstack');
}

export function prefsPath(env = process.env) {
  return path.join(zedpstackHome(env), 'acp-prefs.json');
}

export function loadPrefs(env = process.env) {
  const file = prefsPath(env);
  if (!fs.existsSync(file)) {
    return { lastRuntime: 'claude', perRuntime: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    return {
      lastRuntime: Object.hasOwn(RUNTIME_NAMES, data?.lastRuntime) ? data.lastRuntime : 'claude',
      perRuntime: Object.fromEntries(Object.entries(record(data?.perRuntime) ? data.perRuntime : {}).filter(
        ([runtime, values]) => Object.hasOwn(RUNTIME_NAMES, runtime) && record(values),
      )),
    };
  } catch {
    return { lastRuntime: 'claude', perRuntime: {} };
  }
}

export function savePrefs(prefs, env = process.env) {
  const file = prefsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** One shared document requires exclusion across hubs as well as atomic publication to readers. */
export async function updatePrefs(mutate, env = process.env) {
  const file = prefsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const staging = `${file}.lock-${owner}`;
  const lock = `${file}.lock`;
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.writeFileSync(path.join(staging, owner), '');
  const deadline = Date.now() + 5000;
  let acquired = false;
  try {
    while (!acquired) {
      try {
        // Publish a nonempty directory so stale cleanup cannot remove a new owner's empty lock.
        fs.renameSync(staging, lock);
        acquired = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        let names;
        try { names = fs.readdirSync(lock); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          continue;
        }
        for (const name of names) {
          const pid = Number(/^(\d+)-[a-f0-9]+$/.exec(name)?.[1]);
          if (!pid) continue;
          try { process.kill(pid, 0); } catch (error) {
            if (error.code === 'ESRCH') fs.rmSync(path.join(lock, name), { force: true });
          }
        }
        try { fs.rmdirSync(lock); } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
        if (Date.now() >= deadline) throw new Error(`timed out updating ACP preferences: ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const prefs = loadPrefs(env);
    if (mutate(prefs) === false) return false;
    savePrefs(prefs, env);
    return true;
  } finally {
    if (acquired) {
      fs.renameSync(lock, staging);
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const RUNTIME_FIRST_LINE_RE = /^(?:\/)?(claude|codex|cursor)\s*$/i;

export function parseRuntimeSwitch(text) {
  const raw = String(text ?? '');
  const nl = raw.indexOf('\n');
  const firstLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  const m = firstLine.match(RUNTIME_FIRST_LINE_RE);
  if (!m) return null;
  return m[1].toLowerCase();
}
