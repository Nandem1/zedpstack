import fs from 'node:fs';

const liveTimers = new Set();
for (const [setName, clearName, once] of [
  ['setTimeout', 'clearTimeout', true],
  ['setInterval', 'clearInterval', false],
]) {
  const originalSet = globalThis[setName];
  const originalClear = globalThis[clearName];
  globalThis[setName] = (fn, ...args) => {
    const handle = originalSet((...callbackArgs) => {
      if (once) liveTimers.delete(handle);
      fn(...callbackArgs);
    }, ...args);
    liveTimers.add(handle);
    return handle;
  };
  globalThis[clearName] = (handle) => {
    liveTimers.delete(handle);
    originalClear(handle);
  };
}

const { createHub } = await import('../../src/acp/hub.mjs');
const { startEngine } = await import('../../src/acp/engine.mjs');
const { isProcessAlive } = await import('../../src/agents/store.mjs');
const [mode, repo] = process.argv.slice(2);
const enginePids = [];
const mcpPids = [];
const updates = [];
const handleCounts = [];
const timerCounts = [];
let closedSessions = 0;
let hadFourTurns = false;
const userText = (text) => [{ type: 'text', text }];
const settle = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

const hub = createHub({
  env: process.env,
  log: () => {},
  zed: {
    request: async () => ({ outcome: { outcome: 'selected', optionId: 'ok' } }),
    notify: (params) => updates.push(params),
  },
  spawnEngine: async (opts) => {
    const engine = await startEngine(opts);
    enginePids.push(engine.pid);
    return engine;
  },
});
process.stdout.write('');
process.stderr.write('');
await settle();
const baselineHandles = process._getActiveHandles().length;

try {
  if (mode === 'loop') {
    for (let i = 0; i < 50; i += 1) {
      const { sessionId } = await hub.handle['session/new']({ cwd: repo, mcpServers: [] });
      if (i % 10 === 0) {
        const result = await hub.handle['session/prompt']({ sessionId, prompt: userText('CRASH') });
        if (result.stopReason !== 'refusal') throw new Error(`crash answered ${result.stopReason}`);
      } else {
        const turn = hub.handle['session/prompt']({ sessionId, prompt: userText('SLEEP') });
        await settle();
        await hub.notify({ method: 'session/cancel', params: { sessionId } });
        if ((await turn).stopReason !== 'cancelled') throw new Error('cancel did not end the turn');
      }
      await hub.handle['session/close']({ sessionId });
      closedSessions += 1;
      await settle();
      handleCounts.push(process._getActiveHandles().length);
      timerCounts.push(liveTimers.size);
    }
  } else if (mode === 'shutdown') {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => hub.handle['session/new']({ cwd: repo, mcpServers: [] })));
    let settledTurns = 0;
    const turns = sessions.map(({ sessionId }) => hub.handle['session/prompt']({ sessionId, prompt: userText('MCPHOLD SLEEP') })
      .then((result) => { settledTurns += 1; return result; }));
    const deadline = Date.now() + 10_000;
    while (mcpPids.length < 4) {
      for (const update of updates) {
        const text = update.update?.content?.text;
        if (text?.startsWith('mcp:')) {
          const pid = Number(text.slice(4));
          if (!mcpPids.includes(pid)) mcpPids.push(pid);
        }
      }
      if (Date.now() >= deadline) throw new Error('four MCP children did not start');
      if (mcpPids.length < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    hadFourTurns = settledTurns === 0 && enginePids.every(isProcessAlive) && mcpPids.every(isProcessAlive);
    await hub.shutdown();
    const results = await Promise.all(turns);
    if (results.some((result) => result.stopReason !== 'cancelled')) throw new Error('shutdown did not cancel every turn');
  } else {
    throw new Error(`unknown resource mode ${mode}`);
  }
} finally {
  await hub.shutdown();
}

await settle();
const deadline = Date.now() + 5000;
while ([...enginePids, ...mcpPids].some(isProcessAlive) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(JSON.stringify({
  enginePids,
  mcpPids,
  bridgePath: hub.bridgePath,
  socketExists: fs.existsSync(hub.bridgePath),
  hadFourTurns,
  closedSessions,
  baselineHandles,
  handleCounts,
  timerCounts,
  liveTimers: liveTimers.size,
  liveChildPids: [...enginePids, ...mcpPids].filter(isProcessAlive),
}));
