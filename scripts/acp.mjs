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

  let exiting = false;
  const shutdown = (code) => {
    if (exiting) return;
    exiting = true;
    hub.shutdown()
      .catch((error) => process.stderr.write(`[zedpstack-acp] shutdown failed: ${error?.stack ?? error}\n`))
      .finally(() => {
        zedPeer.close();
        process.exit(code);
      });
  };
  const crash = (error) => {
    process.stderr.write(`[zedpstack-acp] ${error?.stack ?? error}\n`);
    shutdown(1);
  };

  process.stdin.on('close', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

main();
