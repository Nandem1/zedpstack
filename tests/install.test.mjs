import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardEditsHookCommand, runInstall } from '../src/install.mjs';

describe('install', () => {
  it('dry run changes nothing; apply registers codex, cursor and skill links idempotently', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-home-'));
    delete process.env.CODEX_HOME;
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    const dry = runInstall({ hosts: ['codex', 'cursor'], home });
    assert.ok(dry.every((h) => h.actions.every((a) => a.result !== 'linked')));
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'config.toml')));

    runInstall({ hosts: ['codex', 'cursor'], home, apply: true });
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.zedpstack\]/);
    assert.match(toml, /tool_timeout_sec = 600/);
    assert.match(toml, /default_tools_approval_mode = "approve"/);
    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cursor.mcpServers.other, 'keeps other servers');
    assert.match(cursor.mcpServers.zedpstack.args[0], /scripts\/mcp\.mjs$/);
    assert.ok(fs.lstatSync(path.join(home, '.codex', 'skills', 'zedpstack')).isSymbolicLink());

    const again = runInstall({ hosts: ['codex', 'cursor'], home, apply: true });
    assert.ok(again.every((h) => h.actions.every((a) => a.result === 'unchanged')));
    assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), toml);
  });

  it('zed is manual and prints a context_servers snippet', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-home-'));
    delete process.env.XDG_CONFIG_HOME;
    const [zed] = runInstall({ hosts: ['zed'], home });
    assert.equal(zed.actions[0].state, 'manual');
    assert.ok(JSON.parse(zed.actions[0].snippet).context_servers.zedpstack.command);
  });
});

describe('claude-code orchestrator edit guard hook', () => {
  it('installs idempotently and preserves other PreToolUse hooks', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-claude-hook-'));
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Custom', hooks: [{ type: 'command', command: 'echo keep' }] }] },
      }),
    );

    const [first] = runInstall({ hosts: ['claude-code'], home, apply: true });
    const guard = first.actions.find((a) => a.kind === 'orchestrator-edit-guard');
    assert.ok(guard);
    assert.equal(guard.result, 'installed');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks.PreToolUse.some((e) => e.matcher === 'Custom'));
    assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks[0].command === guardEditsHookCommand()));

    const [again] = runInstall({ hosts: ['claude-code'], home, apply: true });
    assert.equal(again.actions.find((a) => a.kind === 'orchestrator-edit-guard').result, 'unchanged');
  });
});

describe('install updates outdated registrations', () => {
  it('rewrites a codex block that points at an old node binary, keeping other sections', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-home-'));
    delete process.env.CODEX_HOME;
    const cfg = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, 'model = "x"\n\n[mcp_servers.zedpstack]\ncommand = "/old/node"\nargs = ["/old/mcp.mjs"]\n\n[features]\nmulti_agent = true\n');
    const [codex] = runInstall({ hosts: ['codex'], home });
    assert.equal(codex.actions.at(-1).state, 'outdated');
    runInstall({ hosts: ['codex'], home, apply: true });
    const toml = fs.readFileSync(cfg, 'utf8');
    assert.doesNotMatch(toml, /\/old\/node/);
    assert.match(toml, /\[features\]\nmulti_agent = true/);
    assert.equal(toml.match(/\[mcp_servers\.zedpstack\]/g).length, 1);
    const [again] = runInstall({ hosts: ['codex'], home });
    assert.equal(again.actions.at(-1).state, 'ok');
  });
});
