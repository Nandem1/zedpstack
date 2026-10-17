import fs from 'node:fs';
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
  const values = installed.length ? installed : ['claude', 'codex', 'cursor'];
  return {
    id: ZP_RUNTIME_ID,
    name: 'Orchestrator',
    category: '_zedpstack',
    type: 'select',
    currentValue: current,
    options: values.map((value) => ({ value, name: RUNTIME_NAMES[value] ?? value })),
  };
}

export function mergeOptions(zpOption, childOptions = []) {
  const rest = (childOptions ?? []).filter((o) => o?.id !== ZP_RUNTIME_ID);
  return [zpOption, ...rest];
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
    name: 'spawn',
    description: 'Lanza un worker: /spawn <rol> :: <prompt>  o  /spawn xN <rol> :: <prompt>',
    input: { hint: '<rol> :: <prompt>' },
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
  return env.ZEDPSTACK_HOME ?? path.join(os.homedir(), '.zedpstack');
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
    return {
      lastRuntime: data.lastRuntime ?? 'claude',
      perRuntime: data.perRuntime ?? {},
    };
  } catch {
    return { lastRuntime: 'claude', perRuntime: {} };
  }
}

export function savePrefs(prefs, env = process.env) {
  const file = prefsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
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
