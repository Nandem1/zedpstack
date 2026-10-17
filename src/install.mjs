/**
 * Register zedpstack with each host: the MCP server (tools + /zedpstack prompt)
 * and the skill symlink. Dry run by default; `--apply` writes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zedpstackRoot } from './paths.mjs';

export const HOSTS = ['claude-code', 'codex', 'cursor', 'zed'];

function mcpCommand() {
  return { command: process.execPath, args: [path.join(zedpstackRoot(), 'scripts', 'mcp.mjs')] };
}

function symlinkAction(linkPath, target) {
  let state = 'missing';
  try {
    const current = fs.readlinkSync(linkPath);
    state = path.resolve(path.dirname(linkPath), current) === target ? 'ok' : 'points-elsewhere';
  } catch (err) {
    if (err.code === 'EINVAL') state = 'not-a-symlink';
  }
  return {
    kind: 'symlink',
    path: linkPath,
    target,
    state,
    apply: () => {
      if (state === 'ok') return 'unchanged';
      if (state === 'not-a-symlink') return `skipped: ${linkPath} exists and is not a symlink`;
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.rmSync(linkPath, { force: true });
      fs.symlinkSync(target, linkPath);
      return 'linked';
    },
  };
}

function skillLinks(skillsDir) {
  const root = zedpstackRoot();
  return [
    symlinkAction(path.join(skillsDir, 'zedpstack'), root),
    symlinkAction(path.join(skillsDir, 'setup-zedpstack'), path.join(root, 'setup-zedpstack')),
  ];
}

function claudeCodeActions(home) {
  const { command, args } = mcpCommand();
  const probe = spawnSync('claude', ['mcp', 'get', 'zedpstack'], { encoding: 'utf8' });
  const registered = probe.status === 0;
  return [
    ...skillLinks(path.join(home, '.claude', 'skills')),
    {
      kind: 'mcp',
      path: 'claude mcp (user scope)',
      state: registered ? 'ok' : 'missing',
      command: ['claude', 'mcp', 'add', '--scope', 'user', 'zedpstack', '--', command, ...args].join(' '),
      apply: () => {
        if (registered) return 'unchanged';
        const res = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'zedpstack', '--', command, ...args], {
          encoding: 'utf8',
        });
        return res.status === 0 ? 'registered' : `failed: ${(res.stderr || res.stdout).trim()}`;
      },
    },
  ];
}

function codexActions(home) {
  const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const { command, args } = mcpCommand();
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const block = [
    '',
    '[mcp_servers.zedpstack]',
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    'tool_timeout_sec = 600',
    '# codex exec and ACP sessions have no one to approve each MCP call',
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n');
  const registered = /^\[mcp_servers\.zedpstack\]/m.test(existing);
  return [
    ...skillLinks(path.join(codexHome, 'skills')),
    {
      kind: 'mcp',
      path: configPath,
      state: registered ? 'ok' : 'missing',
      snippet: block.trim(),
      apply: () => {
        if (registered) return 'unchanged';
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.appendFileSync(configPath, block, 'utf8');
        return 'appended';
      },
    },
  ];
}

function cursorActions(home) {
  const configPath = path.join(home, '.cursor', 'mcp.json');
  let data = {};
  let parseError = null;
  if (fs.existsSync(configPath)) {
    try {
      data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      parseError = err.message;
    }
  }
  const registered = Boolean(data.mcpServers?.zedpstack);
  return [
    ...skillLinks(path.join(home, '.agents', 'skills')),
    {
      kind: 'mcp',
      path: configPath,
      state: parseError ? 'unparseable' : registered ? 'ok' : 'missing',
      snippet: JSON.stringify({ mcpServers: { zedpstack: mcpCommand() } }, null, 2),
      apply: () => {
        if (parseError) return `skipped: ${configPath} is not valid JSON (${parseError})`;
        if (registered) return 'unchanged';
        data.mcpServers = { ...(data.mcpServers ?? {}), zedpstack: mcpCommand() };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        return 'written';
      },
    },
  ];
}

function zedActions(home) {
  const configPath = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'zed', 'settings.json');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const registered = /"zedpstack"\s*:/.test(existing);
  const { command, args } = mcpCommand();
  return [
    {
      kind: 'mcp',
      path: configPath,
      state: registered ? 'ok' : 'manual',
      snippet: JSON.stringify(
        { context_servers: { zedpstack: { source: 'custom', command, args, env: {} } } },
        null,
        2,
      ),
      note: 'Zed settings are JSONC with comments; merge the snippet by hand. Zed forwards context servers to its external agents.',
      apply: () => (registered ? 'unchanged' : 'manual: merge the snippet into Zed settings'),
    },
  ];
}

const BUILDERS = {
  'claude-code': claudeCodeActions,
  codex: codexActions,
  cursor: cursorActions,
  zed: zedActions,
};

export function planInstall({ hosts = HOSTS, home = os.homedir() } = {}) {
  return hosts.map((host) => {
    const build = BUILDERS[host];
    if (!build) throw new Error(`unknown host "${host}". Hosts: ${HOSTS.join(', ')}`);
    return { host, actions: build(home) };
  });
}

export function runInstall({ hosts, apply = false, home } = {}) {
  return planInstall({ hosts, home }).map(({ host, actions }) => ({
    host,
    actions: actions.map(({ apply: doApply, ...rest }) => ({
      ...rest,
      result: apply ? doApply() : rest.state === 'ok' ? 'ok' : 'would change (pass --apply)',
    })),
  }));
}
