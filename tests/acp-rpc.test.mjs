import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPeer } from '../src/acp/rpc.mjs';

function linkPeers() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = createPeer({ input: bToA, output: aToB, label: 'a' });
  const b = createPeer({ input: aToB, output: bToA, label: 'b' });
  return { a, b };
}

describe('acp rpc', () => {
  it('request/response both ways', async () => {
    const { a, b } = linkPeers();
    b.onRequest(async (method, params) => {
      assert.equal(method, 'ping');
      assert.deepEqual(params, { x: 1 });
      return { ok: true };
    });
    const res = await a.request('ping', { x: 1 });
    assert.deepEqual(res, { ok: true });
    a.close();
    b.close();
  });

  it('rejects pending on close', async () => {
    const { a, b } = linkPeers();
    b.onRequest(() => new Promise(() => {}));
    try {
      const p = a.request('slow', {});
      const rejected = assert.rejects(p, /closed/);
      a.close();
      await rejected;
    } finally {
      a.close();
      b.close();
    }
  });

  it('invalid JSON yields -32700', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on('data', (c) => lines.push(c.toString()));
    const peer = createPeer({ input, output });
    input.write('not json\n');
    await new Promise((r) => setImmediate(r));
    const msg = JSON.parse(lines.join('').trim());
    assert.equal(msg.error.code, -32700);
    peer.close();
  });

  it('unknown method yields -32601', async () => {
    const { a, b } = linkPeers();
    b.onRequest(async (method) => {
      if (method !== 'known') {
        throw Object.assign(new Error('nope'), { rpc: -32601 });
      }
      return { ok: 1 };
    });
    const p = a.request('missing', {});
    await assert.rejects(p, (e) => e.rpc === -32601);
    a.close();
    b.close();
  });
});
