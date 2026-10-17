#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');

let sessionId = null;
let modelValue = 'alpha';
let modeValue = 'agent';
let authenticated = process.env.FAKE_ACP_AUTH !== '1';
let authResolve;
const authReady = new Promise((resolve) => { authResolve = resolve; });
let sleepTimer = null;
let sleepPromptId = null;
let sleepResolve = null;
let nextClientReqId = 1000;

const write = (...messages) => process.stdout.write(messages.map((obj) => `${JSON.stringify(obj)}\n`).join(''));
const err = (code, message, data) => ({ code, message, ...(data ? { data } : {}) });

const pendingClient = new Map();
const availableCommands = process.env.FAKE_ACP_COMMANDS
  ? JSON.parse(process.env.FAKE_ACP_COMMANDS)
  : [
      { name: 'help', description: 'Child help' },
      { name: 'compact', description: 'Compact conversation' },
    ];

function commandNotification() {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    },
  };
}

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
  if (process.env.FAKE_ACP_TRACE) {
    fs.appendFileSync(process.env.FAKE_ACP_TRACE, `${JSON.stringify({ pid: process.pid, method, params })}\n`);
  }
  if (process.env.FAKE_ACP_EXIT_METHOD === method) {
    process.stderr.write('credentials unavailable\n', () => process.exit(23));
    return;
  }
  if (process.env.FAKE_ACP_HANG_METHOD === method) {
    process.stderr.write(`${method} is waiting for credentials\n`);
    return;
  }
  if (process.env.FAKE_ACP_FAIL_METHOD === method) {
    process.stderr.write(`${method}: credentials rejected\n`);
    const data = process.env.FAKE_ACP_ERROR_DETAIL ? { message: process.env.FAKE_ACP_ERROR_DETAIL } : undefined;
    write({ jsonrpc: '2.0', id, error: err(-32603, `${method} failed`, data) });
    return;
  }
  switch (method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          agentInfo: { name: 'fake-acp-agent' },
          authMethods: process.env.FAKE_ACP_AUTH === '1'
            ? JSON.parse(process.env.FAKE_ACP_AUTH_METHODS ?? '[{"id":"cursor_login","name":"Cursor Login"}]')
            : [],
        },
      });
      break;
    case 'authenticate':
      if (process.env.FAKE_ACP_EXPECT_AUTH && params.methodId !== process.env.FAKE_ACP_EXPECT_AUTH) {
        throw new Error(`unexpected auth method ${params.methodId}`);
      }
      authenticated = true;
      authResolve();
      write({ jsonrpc: '2.0', id, result: {} });
      break;
    case 'session/new': {
      if (!authenticated) await authReady;
      sessionId = `child-${Date.now()}`;
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          ...(process.env.FAKE_ACP_LEGACY === '1' ? {
            models: {
              currentModelId: modelValue,
              availableModels: [{ modelId: 'alpha', name: 'Alpha' }, { modelId: 'beta', name: 'Beta' }],
            },
            modes: {
              currentModeId: modeValue,
              availableModes: [
                { id: 'agent', name: 'Agent', description: 'Make changes' },
                { id: 'plan', name: 'Plan', description: 'Plan changes' },
              ],
            },
          } : { configOptions: configOptions() }),
        },
      };
      if (process.env.FAKE_ACP_COMMANDS_TIMING === 'prompt') write(response);
      else write(response, commandNotification());
      break;
    }
    case 'session/set_config_option':
      if (process.env.FAKE_ACP_LEGACY === '1') throw new Error('legacy agent has no set_config_option');
      if (params.configId === 'model') modelValue = params.value;
      write(commandNotification(), { jsonrpc: '2.0', id, result: { configOptions: configOptions() } }, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
        },
      });
      break;
    case 'session/set_model':
    case 'session/set_mode': {
      const isModel = method === 'session/set_model';
      if (isModel) modelValue = params.modelId;
      else modeValue = params.modeId;
      write({
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId,
          update: isModel
            ? { sessionUpdate: 'current_model_update', currentModelId: modelValue }
            : { sessionUpdate: 'current_mode_update', currentModeId: modeValue },
        },
      }, { jsonrpc: '2.0', id, result: {} });
      break;
    }
    case 'session/prompt': {
      if (process.env.FAKE_ACP_COMMANDS_TIMING === 'prompt') write(commandNotification());
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
