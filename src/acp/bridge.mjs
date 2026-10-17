import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { isProcessAlive } from '../agents/store.mjs';
import { zedpstackHome } from './options.mjs';

/**
 * Permission bridge between the MCP server an engine runs and the ACP hub that
 * owns the Zed connection. One Unix socket per hub, newline-delimited JSON:
 *
 *   request   {id, sessionId, action, agentId?, title, detail}
 *   response  {id, allowed, reason?}
 */

export const BRIDGE_ENV = 'ZEDPSTACK_ACP_BRIDGE';
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

const SOCKET_RE = /^acp-(\d+)(?:-\d+)?\.sock$/;
// sun_path is 104 bytes on macOS, 108 on Linux, including the terminating NUL.
const MAX_SOCKET_PATH = 103;
let hubsInProcess = 0;

export function bridgeDir(env = process.env) {
  return path.join(zedpstackHome(env), 'run');
}

function removeStaleSockets(dir) {
  for (const name of fs.readdirSync(dir)) {
    const pid = Number(SOCKET_RE.exec(name)?.[1]);
    if (pid && pid !== process.pid && !isProcessAlive(pid)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Starts listening at once; `ready` settles when the socket accepts connections.
 * `onAsk(request, signal)` resolves `{allowed, reason?}`; `signal` aborts when the
 * asking client disconnects first.
 *
 * @param {{ env?: object, onAsk: (req: object, signal: AbortSignal) => Promise<{allowed: boolean, reason?: string}> }} opts
 */
export function startBridge({ env = process.env, onAsk }) {
  const dir = bridgeDir(env);
  // A second hub in one process (tests) needs its own socket under the same pid.
  const n = hubsInProcess++;
  const socketPath = path.join(dir, n === 0 ? `acp-${process.pid}.sock` : `acp-${process.pid}-${n}.sock`);
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const gone = new AbortController();
    socket.on('close', () => {
      sockets.delete(socket);
      gone.abort();
    });
    socket.on('error', () => {});
    const reply = (obj) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
    };
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity }).on('error', () => {});
    lines.on('line', async (line) => {
      if (!line.trim()) return;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        reply({ id: null, allowed: false, reason: 'bad request' });
        return;
      }
      if (!req || typeof req !== 'object' || typeof req.action !== 'string') {
        reply({ id: req?.id ?? null, allowed: false, reason: 'bad request' });
        return;
      }
      let verdict;
      try {
        verdict = await onAsk(req, gone.signal);
      } catch (e) {
        verdict = { allowed: false, reason: e.message ?? String(e) };
      }
      reply({ id: req.id ?? null, allowed: verdict.allowed === true, ...(verdict.reason ? { reason: verdict.reason } : {}) });
    });
  });
  server.unref();

  const ready = new Promise((resolve, reject) => {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      reject(new Error(`socket path longer than ${MAX_SOCKET_PATH} bytes: ${socketPath}; use a shorter ZEDPSTACK_HOME`));
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      removeStaleSockets(dir);
      fs.rmSync(socketPath, { force: true });
    } catch (e) {
      reject(e);
      return;
    }
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (e) {
        reject(e);
        return;
      }
      resolve(socketPath);
    });
  });
  ready.catch(() => {});

  let closing = null;
  return {
    path: socketPath,
    ready,
    close() {
      closing ??= ready.catch(() => {}).then(() => new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        if (!server.listening) resolve();
      })).finally(() => fs.rmSync(socketPath, { force: true }));
      return closing;
    },
  };
}

/**
 * Asks the human through the hub. With no bridge configured (any non-ACP host)
 * it allows at once and touches nothing; with one configured it fails closed.
 *
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export function askHuman({ action, agentId = null, title, detail = '', env = process.env, timeoutMs = DEFAULT_ASK_TIMEOUT_MS }) {
  const socketPath = env[BRIDGE_ENV];
  if (!socketPath) return Promise.resolve({ allowed: true });
  const id = randomBytes(6).toString('hex');
  const request = { id, sessionId: env.ZEDPSTACK_ACP_SESSION ?? null, action, agentId, title, detail };
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ allowed: false, reason: `no answer from the user within ${Math.round(timeoutMs / 1000)} s` }),
      timeoutMs,
    );
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', (e) => finish({ allowed: false, reason: `permission bridge unreachable: ${e.code ?? e.message}` }));
    socket.on('close', () => finish({ allowed: false, reason: 'permission bridge closed before answering' }));
    // readline re-emits the socket's errors; the socket's own handler already answered them.
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity }).on('error', () => {});
    lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.id !== id) return;
      finish({ allowed: msg.allowed === true, ...(msg.reason ? { reason: msg.reason } : {}) });
    });
  });
}
