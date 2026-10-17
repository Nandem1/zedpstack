#!/usr/bin/env node
const readline = require('node:readline');

let sessionId = null;
let modelValue = 'alpha';
let sleepTimer = null;
let sleepPromptId = null;
let sleepResolve = null;
let nextClientReqId = 1000;

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const err = (code, message) => ({ code, message });

const pendingClient = new Map();

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelValue,
      options: [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }],
    },
  ];
}

function promptText(prompt) {
  return (prompt ?? [])
    .filter((b) => b?.type === 'text' && b.text != null)
    .map((b) => b.text)
    .join('\n');
}

function clientRequest(method, params) {
  const id = nextClientReqId++;
  write({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingClient.set(id, { resolve, reject });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: err(-32700, 'Parse error') });
    return;
  }

  if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
    const pending = pendingClient.get(msg.id);
    if (pending) {
      pendingClient.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'session/cancel') {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (sleepPromptId != null) {
      write({ jsonrpc: '2.0', id: sleepPromptId, result: { stopReason: 'cancelled' } });
      sleepPromptId = null;
    }
    if (sleepResolve) {
      sleepResolve();
      sleepResolve = null;
    }
    return;
  }

  if (msg.id === undefined || msg.id === null || !msg.method) return;

  handleRequest(msg).catch((e) => {
    write({ jsonrpc: '2.0', id: msg.id, error: err(-32603, e.message) });
  });
});

async function handleRequest(msg) {
  const { method, params = {}, id } = msg;
  switch (method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          agentInfo: { name: 'fake-acp-agent' },
        },
      });
      break;
    case 'session/new':
      sessionId = `child-${Date.now()}`;
      write({
        jsonrpc: '2.0',
        id,
        result: { sessionId, configOptions: configOptions() },
      });
      break;
    case 'session/set_config_option':
      if (params.configId === 'model') modelValue = params.value;
      write({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
        },
      });
      break;
    case 'session/prompt': {
      const text = promptText(params.prompt);
      if (text.includes('SLEEP')) {
        sleepPromptId = id;
        await new Promise((resolve) => {
          sleepResolve = resolve;
          sleepTimer = setTimeout(() => {
            sleepTimer = null;
            sleepPromptId = null;
            sleepResolve = null;
            resolve();
          }, 60_000);
        });
        break;
      }
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk-1' },
          },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'chunk-2' },
          },
        },
      });
      if (text.includes('ASK')) {
        const result = await clientRequest('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 't1', title: 'ask' },
          options: [{ optionId: 'ok', name: 'OK' }],
        });
        const outcome = result?.outcome?.outcome ?? 'cancelled';
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `perm:${outcome}` },
            },
          },
        });
      }
      if (text.includes('FS')) {
        await clientRequest('fs/read_text_file', { sessionId, path: '/tmp/x' });
      }
      write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      break;
    }
    default:
      write({ jsonrpc: '2.0', id, error: err(-32601, `unknown ${method}`) });
  }
}

process.stdin.on('close', () => process.exit(0));
