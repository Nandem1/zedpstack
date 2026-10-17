import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  allowEdits,
  bashLooksLikeRepoWrite,
  decide,
  readDenialAudit,
  readSession,
  sessionFile,
  startSession,
} from '../src/guard.mjs';
import { buildDoctorReport, formatDoctorReport } from '../src/setupReport.mjs';
import { handleRequest } from '../src/mcp/server.mjs';
import { childEnv } from './helpers/env.mjs';

describe('orchestrator edit guard decide()', () => {
  it('denies Edit inside repo, allows outside and .zedpstack', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    startSession(repo);
    const inside = path.join(repo, 'src', 'a.mjs');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    const deny = decide({ tool: 'Edit', input: { file_path: inside }, cwd: repo, env: {} });
    assert.equal(deny.deny, true);
    assert.match(deny.reason, /delegate this edit via spawn_agent/);

    const outside = path.join(os.tmpdir(), 'memory.md');
    const allowOut = decide({ tool: 'Edit', input: { file_path: outside }, cwd: repo, env: {} });
    assert.equal(allowOut.deny, false);

    const internal = path.join(repo, '.zedpstack', 'notes.txt');
    fs.mkdirSync(path.dirname(internal), { recursive: true });
    const allowInternal = decide({ tool: 'Edit', input: { file_path: internal }, cwd: repo, env: {} });
    assert.equal(allowInternal.deny, false);
  });

  it('exempts workers, allow-edits flag, and expired marker', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    startSession(repo);
    const target = path.join(repo, 'x.txt');
    assert.equal(
      decide({ tool: 'Write', input: { file_path: target }, cwd: repo, env: { ZEDPSTACK_AGENT_ID: 'w1' } }).deny,
      false,
    );
    allowEdits(repo, true);
    assert.equal(decide({ tool: 'Write', input: { file_path: target }, cwd: repo, env: {} }).deny, false);
    allowEdits(repo, false);

    const expired = {
      startedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
      repo,
      pid: 1,
    };
    fs.writeFileSync(sessionFile(repo), JSON.stringify(expired));
    assert.equal(readSession(repo), null);
    assert.equal(decide({ tool: 'Edit', input: { file_path: target }, cwd: repo, env: {} }).deny, false);
  });

  it('bash sed -i denied, plain ls allowed; malformed input fails open', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    startSession(repo);
    const file = path.join(repo, 'a.txt');
    const sed = decide({ tool: 'Bash', input: { command: `sed -i '' 's/a/b' ${file}` }, cwd: repo, env: {} });
    assert.equal(sed.deny, true);
    assert.equal(decide({ tool: 'Bash', input: { command: 'ls -la' }, cwd: repo, env: {} }).deny, false);
    assert.equal(decide({ tool: 'Edit', input: null, cwd: repo, env: {} }).deny, false);
  });

  it('bash redirect heuristics allow stderr/pipe noise and deny repo writes', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    startSession(repo);
    const allow = [
      'npm test 2>&1 | tail -5',
      'ls 2>/dev/null',
      'git log > /tmp/x',
      'echo a >&2',
      'node -e "console.log(a=>b)"',
    ];
    for (const command of allow) {
      assert.equal(bashLooksLikeRepoWrite(command, repo, repo), null);
      assert.equal(decide({ tool: 'Bash', input: { command }, cwd: repo, env: {} }).deny, false);
    }
    const deny = [
      'echo x > src/a.mjs',
      'echo x >> README.md',
      'cat <<EOF > src/a.mjs',
      'sed -i s/a/b/ src/a.mjs',
      'printf x | tee src/a.mjs',
    ];
    for (const command of deny) {
      assert.ok(bashLooksLikeRepoWrite(command, repo, repo));
      assert.equal(decide({ tool: 'Bash', input: { command }, cwd: repo, env: {} }).deny, true);
    }
  });

  it('bash repo-write paths resolve against payload cwd', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    startSession(repo);
    assert.equal(bashLooksLikeRepoWrite('echo x > out.txt', repo, sub), 'pkg/out.txt');
    assert.equal(decide({ tool: 'Bash', input: { command: 'echo x > out.txt' }, cwd: sub, env: {} }).deny, true);
  });

  it('startSession refresh keeps editsAllowed within TTL', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-'));
    startSession(repo);
    allowEdits(repo, true);
    startSession(repo);
    const marker = JSON.parse(fs.readFileSync(sessionFile(repo), 'utf8'));
    assert.equal(marker.editsAllowed, true);
  });
});

describe('guard-edits hook script', () => {
  it('exits 2 on denial and appends audit', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-hook-'));
    startSession(repo);
    const target = path.join(repo, 'b.txt');
    const hookScript = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'guard-edits.mjs');
    const res = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: target }, cwd: repo }),
      encoding: 'utf8',
      env: childEnv({ ZEDPSTACK_REPO: repo }),
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /delegate this edit via spawn_agent/);
    assert.equal(readDenialAudit(repo).count, 1);
  });
});

describe('doctor orchestrator edit guard', () => {
  it('includes hook, session, and denial stats', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-doc-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-doc-repo-'));
    const prev = process.cwd();
    process.chdir(repo);
    startSession(repo);
    const report = buildDoctorReport({ home });
    const text = formatDoctorReport(report);
    assert.equal(report.orchestratorEditGuard.sessionActive, true);
    assert.match(text, /Orchestrator edit guard:/);
    assert.match(text, /session: active/);
    process.chdir(prev);
  });
});

describe('mcp read_skill session marker', () => {
  it('writes session.json on read_skill poteto-mode and preserves editsAllowed on repeat', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mcp-read-skill-'));
    const prevRepo = process.env.ZEDPSTACK_REPO;
    const prevCwd = process.cwd();
    process.env.ZEDPSTACK_REPO = repo;
    process.chdir(repo);
    try {
      await handleRequest({ method: 'tools/call', params: { name: 'read_skill', arguments: { skill: 'poteto-mode' } } });
      assert.ok(fs.existsSync(path.join(repo, '.zedpstack', 'session.json')));
      allowEdits(repo, true);
      await handleRequest({ method: 'tools/call', params: { name: 'read_skill', arguments: { skill: 'zedpstack' } } });
      const marker = JSON.parse(fs.readFileSync(path.join(repo, '.zedpstack', 'session.json'), 'utf8'));
      assert.equal(marker.editsAllowed, true);
    } finally {
      process.chdir(prevCwd);
      if (prevRepo === undefined) delete process.env.ZEDPSTACK_REPO;
      else process.env.ZEDPSTACK_REPO = prevRepo;
    }
  });
});

describe('mcp prompts/get session marker', () => {
  it('writes .zedpstack/session.json for the default repo', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mcp-session-'));
    const prevRepo = process.env.ZEDPSTACK_REPO;
    const prevCwd = process.cwd();
    process.env.ZEDPSTACK_REPO = repo;
    process.chdir(repo);
    try {
      await handleRequest({ method: 'prompts/get', params: { name: 'zedpstack', arguments: { task: 't' } } });
      assert.ok(fs.existsSync(path.join(repo, '.zedpstack', 'session.json')));
      const marker = JSON.parse(fs.readFileSync(path.join(repo, '.zedpstack', 'session.json'), 'utf8'));
      assert.equal(path.resolve(marker.repo), path.resolve(repo));
      assert.ok(marker.startedAt);
      assert.ok(marker.pid);
    } finally {
      process.chdir(prevCwd);
      if (prevRepo === undefined) delete process.env.ZEDPSTACK_REPO;
      else process.env.ZEDPSTACK_REPO = prevRepo;
    }
  });
});
