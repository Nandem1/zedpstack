#!/usr/bin/env node
import { createHub } from '../src/acp/hub.mjs';
import { createPeer } from '../src/acp/rpc.mjs';

function main() {
  const zedPeer = createPeer({ input: process.stdin, output: process.stdout, label: 'zed' });
  const zed = {
    request(method, params) {
      return zedPeer.request(method, params);
    },
    notify(params) {
      zedPeer.notify('session/update', params);
    },
  };

  const hub = createHub({ zed, env: process.env });

  zedPeer.onRequest(async (method, params) => {
    const handler = hub.handle[method];
    if (!handler) {
      throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
    }
    return handler(params);
  });

  zedPeer.onNotification((method, params) => {
    hub.notify({ method, params });
  });

  const shutdown = async () => {
    await hub.shutdown();
    zedPeer.close();
  };

  process.stdin.on('close', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
}

main();
