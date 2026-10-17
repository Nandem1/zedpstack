import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { askHuman, bridgeDir, startBridge } from '../src/acp/bridge.mjs';
import { shortHome } from './helpers/acpHub.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withBridge(t, onAsk) {
  const env = { ZEDPSTACK_HOME: shortHome('zp-br-') };
  const bridge = startBridge({ env, onAsk });
  t.after(() => bridge.close());
  await bridge.ready;
  return { bridge, env, client: { ZEDPSTACK_ACP_BRIDGE: bridge.path, ZEDPSTACK_ACP_SESSION: 'sess-1' } };
}

/** One raw connection: write `chunks` as given, collect `count` response lines. */
function rawExchange(socketPath, chunks, count) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const lines = [];
    readline.createInterface({ input: socket }).on('line', (line) => {
      lines.push(JSON.parse(line));
      if (lines.length === count) {
        socket.destroy();
        resolve(lines);
      }
    });
    socket.on('error', reject);
    socket.on('connect', async () => {
      for (const part of chunks) {
        socket.write(part);
        await sleep(20);
      }
    });
  });
}

describe('acp permission bridge', () => {
  it('allows at once with no bridge configured, without touching the network', async () => {
    let settled = null;
    askHuman({ action: 'apply_agent_changes', title: 't', env: {} }).then((v) => {
      settled = v;
    });
    await Promise.resolve();
    assert.deepEqual(settled, { allowed: true });
  });

  it('carries the request fields and the session from the env, and answers by id', async (t) => {
    const seen = [];
    const { client } = await withBridge(t, async (req) => {
      seen.push(req);
      return { allowed: req.action === 'ok' };
    });
    const allowed = await askHuman({ action: 'ok', agentId: 'a-1', title: 'Title', detail: 'Detail', env: client });
    const denied = await askHuman({ action: 'no', title: 'T', env: client });
    assert.deepEqual([allowed, denied], [{ allowed: true }, { allowed: false }]);
    assert.deepEqual(
      { ...seen[0], id: typeof seen[0].id },
      { id: 'string', sessionId: 'sess-1', action: 'ok', agentId: 'a-1', title: 'Title', detail: 'Detail' },
    );
  });

  it('frames newline-delimited JSON: batched, split and bad lines on one connection', async (t) => {
    const { bridge } = await withBridge(t, async (req) => {
      await sleep(req.id === 'a' ? 60 : 0);
      return { allowed: req.id !== 'b', reason: `r-${req.id}` };
    });
    const a = JSON.stringify({ id: 'a', sessionId: 's', action: 'x', title: 't' });
    const b = JSON.stringify({ id: 'b', sessionId: 's', action: 'x', title: 't' });
    const c = JSON.stringify({ id: 'c', sessionId: 's', action: 'x', title: 't' });
    const lines = await rawExchange(bridge.path, [`${a}\n${b}\n`, c.slice(0, 10), `${c.slice(10)}\nnot json\n`], 4);
    const byId = Object.fromEntries(lines.map((l) => [l.id ?? 'null', l]));
    assert.deepEqual(byId, {
      a: { id: 'a', allowed: true, reason: 'r-a' },
      b: { id: 'b', allowed: false, reason: 'r-b' },
      c: { id: 'c', allowed: true, reason: 'r-c' },
      null: { id: null, allowed: false, reason: 'bad request' },
    });
    assert.equal(lines.at(-1).id, 'a', 'a slow answer does not hold back the others');
  });

  it('keeps concurrent asks independent', async (t) => {
    const { client } = await withBridge(t, async (req) => {
      await sleep(Math.random() * 50);
      return { allowed: Number(req.agentId) % 2 === 0, reason: req.agentId };
    });
    const verdicts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      askHuman({ action: 'x', agentId: String(i), title: 't', env: client })));
    assert.deepEqual(verdicts.map((v) => [v.allowed, v.reason]), Array.from({ length: 12 }, (_, i) => [i % 2 === 0, String(i)]));
  });

  it('a failing handler denies with its message', async (t) => {
    const { client } = await withBridge(t, async () => {
      throw new Error('boom');
    });
    assert.deepEqual(await askHuman({ action: 'x', title: 't', env: client }), { allowed: false, reason: 'boom' });
  });

  it('a timeout denies and tells the hub the asker is gone', async (t) => {
    let aborted;
    const { client } = await withBridge(t, (req, signal) => new Promise(() => {
      aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    }));
    const verdict = await askHuman({ action: 'x', title: 't', env: client, timeoutMs: 150 });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /no answer from the user/);
    await aborted;
  });

  it('fails closed when the configured bridge is unreachable or closes first', async (t) => {
    const missing = await askHuman({ action: 'x', title: 't', env: { ZEDPSTACK_ACP_BRIDGE: '/tmp/zp-no-such.sock' } });
    assert.equal(missing.allowed, false);
    assert.match(missing.reason, /permission bridge unreachable: ENOENT/);

    const { bridge, client } = await withBridge(t, () => new Promise(() => {}));
    const pending = askHuman({ action: 'x', title: 't', env: client });
    await sleep(50);
    await bridge.close();
    const closed = await pending;
    assert.equal(closed.allowed, false);
    assert.match(closed.reason, /closed before answering/);
  });

  it('owns a 0700 directory and a 0600 socket, unlinked on close', async (t) => {
    const { bridge, env } = await withBridge(t, async () => ({ allowed: true }));
    assert.equal(path.dirname(bridge.path), bridgeDir(env));
    assert.equal(fs.statSync(bridgeDir(env)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(bridge.path).mode & 0o777, 0o600);
    assert.ok(fs.statSync(bridge.path).isSocket());
    await bridge.close();
    assert.equal(fs.existsSync(bridge.path), false);
  });

  it('removes sockets of dead hubs at start and keeps those of live ones', async (t) => {
    const env = { ZEDPSTACK_HOME: shortHome('zp-br-') };
    const dir = bridgeDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.once('exit', resolve));
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    t.after(() => live.kill('SIGKILL'));
    for (const name of [`acp-${dead.pid}.sock`, `acp-${dead.pid}-2.sock`, `acp-${live.pid}.sock`, 'notes.txt']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    const bridge = startBridge({ env, onAsk: async () => ({ allowed: true }) });
    t.after(() => bridge.close());
    await bridge.ready;
    const left = fs.readdirSync(dir).filter((name) => name !== path.basename(bridge.path)).sort();
    assert.deepEqual(left, [`acp-${live.pid}.sock`, 'notes.txt'].sort());
  });

  it('refuses a socket path the OS would truncate', async () => {
    const env = { ZEDPSTACK_HOME: path.join(shortHome('zp-br-'), 'x'.repeat(120)) };
    const bridge = startBridge({ env, onAsk: async () => ({ allowed: true }) });
    await assert.rejects(bridge.ready, /socket path longer than/);
    await bridge.close();
  });
});
