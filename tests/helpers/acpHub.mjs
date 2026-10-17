import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHub } from '../../src/acp/hub.mjs';
import { startEngine } from '../../src/acp/engine.mjs';
import { createPeer } from '../../src/acp/rpc.mjs';
import { FIXTURES } from './sandbox.mjs';

export const FAKE_AGENT = path.join(FIXTURES, 'bin', 'fake-acp-agent.cjs');

export function engineEnv(extra = {}) {
  const cmd = JSON.stringify([process.execPath, FAKE_AGENT]);
  return {
    ZEDPSTACK_ACP_ENGINE_CLAUDE: cmd,
    ZEDPSTACK_ACP_ENGINE_CODEX: cmd,
    ZEDPSTACK_ACP_ENGINE_CURSOR: cmd,
    ...extra,
  };
}

/** A hub wired to a simulated Zed client over in-memory JSON-RPC streams. */
export function connectHub(t, env) {
  const zedToHub = new PassThrough();
  const hubToZed = new PassThrough();
  const zedSim = createPeer({ input: hubToZed, output: zedToHub, label: 'zed-sim' });
  const hubWire = createPeer({ input: zedToHub, output: hubToZed, label: 'hub-wire' });

  const updates = [];
  const clientRequests = [];
  const engines = [];

  zedSim.onNotification((method, params) => {
    if (method === 'session/update') updates.push(params);
  });

  zedSim.onRequest(async (method, params) => {
    clientRequests.push({ method, params });
    if (method === 'session/request_permission') {
      return { outcome: { outcome: 'selected', optionId: 'ok' } };
    }
    if (method === 'fs/read_text_file') {
      return { content: 'file-body' };
    }
    throw Object.assign(new Error(`unexpected zed request ${method}`), { rpc: -32601 });
  });

  const hub = createHub({
    env,
    spawnEngine: async (opts) => {
      const engine = await startEngine({ ...opts, env });
      engines.push(engine);
      return engine;
    },
    zed: {
      request: (method, params) => hubWire.request(method, params),
      notify: (params) => {
        hubWire.notify('session/update', params);
      },
    },
  });

  t.after(async () => {
    try {
      await hub.shutdown();
    } finally {
      try {
        await Promise.all(engines.map((engine) => engine.kill()));
      } finally {
        zedSim.close();
        hubWire.close();
        zedToHub.destroy();
        hubToZed.destroy();
      }
    }
  });

  hubWire.onRequest(async (method, params) => {
    const handler = hub.handle[method];
    if (!handler) throw Object.assign(new Error(`no ${method}`), { rpc: -32601 });
    return handler(params);
  });
  hubWire.onNotification((method, params) => hub.notify({ method, params }));

  const rpc = (method, params = {}) => zedSim.request(method, params);
  const notify = (method, params = {}) => zedSim.notify(method, params);

  return { hub, rpc, notify, updates, clientRequests, engines };
}
