import readline from 'node:readline';

const err = (code, message) => ({ code, message });

/**
 * @param {{ input: import('node:stream').Readable, output: import('node:stream').Writable, label?: string }} opts
 */
export function createPeer({ input, output, label = 'peer' }) {
  let closed = false;
  let nextId = 1;
  const pending = new Map();
  /** @type {((method: string, params: object) => Promise<unknown>) | null} */
  let requestHandler = null;
  /** @type {((method: string, params: object) => void) | null} */
  let notificationHandler = null;

  const write = (obj) => {
    if (closed) return;
    output.write(`${JSON.stringify(obj)}\n`);
  };

  const rejectAllPending = (reason) => {
    for (const [, { reject }] of pending) {
      reject(reason);
    }
    pending.clear();
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    if (closed || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: err(-32700, 'Parse error') });
      return;
    }

    const isResponse = msg.id !== undefined && msg.id !== null && msg.method === undefined;
    if (isResponse) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        const e = Object.assign(new Error(msg.error.message ?? 'RPC error'), { rpc: msg.error.code });
        entry.reject(e);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    const isRequest =
      msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (isRequest) {
      if (!requestHandler) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: err(-32601, `Method not found: ${msg.method}`),
        });
        return;
      }
      try {
        const result = await requestHandler(msg.method, msg.params ?? {});
        write({ jsonrpc: '2.0', id: msg.id, result });
      } catch (e) {
        const code = e.rpc ?? -32603;
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: err(code, e.message ?? String(e)),
        });
      }
      return;
    }

    if (typeof msg.method === 'string' && notificationHandler) {
      try {
        notificationHandler(msg.method, msg.params ?? {});
      } catch {
        /* */
      }
    }
  });

  rl.on('close', () => {
    if (closed) return;
    closed = true;
    rejectAllPending(Object.assign(new Error(`${label}: stream closed`), { rpc: -32000 }));
  });

  return {
    request(method, params = {}) {
      if (closed) {
        return Promise.reject(Object.assign(new Error(`${label}: closed`), { rpc: -32000 }));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params = {}) {
      if (closed) return;
      write({ jsonrpc: '2.0', method, params });
    },
    onRequest(handler) {
      requestHandler = handler;
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
      rejectAllPending(Object.assign(new Error(`${label}: closed`), { rpc: -32000 }));
    },
  };
}
