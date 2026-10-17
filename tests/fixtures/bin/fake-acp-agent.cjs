#!/usr/bin/env node
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');

let sessionId = null;
let receivedMcpServers = [];
let modelValue = 'alpha';
let modeValue = 'agent';
let authenticated = process.env.FAKE_ACP_AUTH !== '1';
let authResolve;
const authReady = new Promise((resolve) => { authResolve = resolve; });
/** The open prompt: `cancelled` once session/cancel arrived, `wake` ends a SLEEP early. */
let currentTurn = null;
let nextClientReqId = 1000;
const heldMcps = [];

// Same watchdog the injected MCP runs: the hub may be SIGKILLed while this process keeps its pipes.
const parentPid = Number(process.env.ZEDPSTACK_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') process.exit(0);
    }
  }, 2000).unref();
}

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

// Markers are read from the user's block only: the hub prepends the orchestrator skill.
function promptText(prompt) {
  return (prompt ?? []).filter((b) => b?.type === 'text' && b.text != null).at(-1)?.text ?? '';
}

function chunk(text) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  };
}

function startInjectedMcp() {
  const server = receivedMcpServers.find((s) => s.name === 'zedpstack');
  if (!server) throw new Error('no zedpstack MCP server injected');
  const env = { ...process.env };
  for (const { name, value } of server.env ?? []) env[name] = value;
  return spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
}

/** Calls one tool on the zedpstack MCP server exactly as the hub injected it. */
function callInjectedMcp(name, args) {
  let mcp;
  try {
    mcp = startInjectedMcp();
  } catch (e) {
    return Promise.reject(e);
  }
  const send = (id, method, params) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        send(2, 'tools/call', { name, arguments: args });
      } else if (msg.id === 2) {
        mcp.stdin.end();
        const { content, isError } = msg.result;
        if (isError) reject(new Error(content[0].text));
        else resolve(JSON.parse(content.at(-1).text));
      }
    });
    mcp.on('error', reject);
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp-agent' } });
  });
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
    if (process.env.FAKE_ACP_TRACE) {
      fs.appendFileSync(process.env.FAKE_ACP_TRACE, `${JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params })}\n`);
    }
    if (currentTurn) {
      currentTurn.cancelled = true;
      currentTurn.wake();
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
      receivedMcpServers = params.mcpServers ?? [];
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
      const turn = { cancelled: false, wake: () => {} };
      currentTurn = turn;
      const respond = (stopReason) => write({ jsonrpc: '2.0', id, result: { stopReason } });
      // A word of its own: FAKE_SLEEP is the worker's marker, not this engine's.
      const sleeps = /\bSLEEP\b/.test(text);
      if (text.includes('CRASH')) {
        process.stderr.write('engine exploded mid-turn\n', () => process.exit(42));
        break;
      }
      if (process.env.FAKE_ACP_MCP === '1' && text.includes('MCPINFO')) {
        write(chunk(JSON.stringify(receivedMcpServers)));
        respond('end_turn');
        break;
      }
      if (process.env.FAKE_ACP_MCP === '1' && text.includes('MCPHOLD')) {
        const mcp = startInjectedMcp();
        heldMcps.push(mcp);
        write(chunk(`mcp:${mcp.pid}`));
      }
      const mcpCall = /^MCPCALL (\S+) (.*)$/m.exec(text);
      if (process.env.FAKE_ACP_MCP === '1' && mcpCall) {
        try {
          const result = await callInjectedMcp(mcpCall[1], JSON.parse(mcpCall[2]));
          write(chunk(`mcp:${mcpCall[1]}:${JSON.stringify(result)}`));
        } catch (e) {
          write(chunk(`mcp-error:${e.message}`));
        }
        respond('end_turn');
        break;
      }
      if (process.env.FAKE_ACP_MCP === '1' && text.includes('SPAWN')) {
        const agent = await callInjectedMcp('spawn_agent', {
          prompt: text, role: 'how explorer', readonly: true, description: 'fake spawn',
        });
        write(chunk(`spawned:${agent.agent_id}`));
        if (!sleeps) {
          respond(turn.cancelled ? 'cancelled' : 'end_turn');
          break;
        }
      }
      if (sleeps) {
        if (!turn.cancelled) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 60_000);
            turn.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        respond(turn.cancelled ? 'cancelled' : 'end_turn');
        break;
      }
      // claude-agent-acp@0.93.0 names the model that answered in usage_update._meta.
      const usage = /\bUSAGE=(\S+)/.exec(text);
      if (usage) {
        for (let i = 0; i < 2; i += 1) {
          write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1, size: 10, _meta: { '_claude/model': usage[1] } } },
          });
        }
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
      // The edits an engine could route through the client: WRITE=<path> and TERM=<shell command>.
      const fsWrite = /\bWRITE=(\S+)/.exec(text);
      if (process.env.FAKE_ACP_FS_WRITE === '1' && fsWrite) {
        const answer = await clientRequest('fs/write_text_file', { sessionId, path: fsWrite[1], content: 'fake\n' })
          .then(() => 'ok', (e) => `error:${e.message}`);
        write(chunk(`fs:${answer}`));
      }
      const term = /\bTERM=(.+)$/m.exec(text);
      if (process.env.FAKE_ACP_TERMINAL === '1' && term) {
        const answer = await clientRequest('terminal/create', { sessionId, command: 'bash', args: ['-c', term[1]] })
          .then(() => 'ok', (e) => `error:${e.message}`);
        write(chunk(`term:${answer}`));
      }
      write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      break;
    }
    default:
      write({ jsonrpc: '2.0', id, error: err(-32601, `unknown ${method}`) });
  }
}

// Like npx's agent: outlives the engine's own exit and shrugs off SIGTERM, so only a group SIGKILL ends it.
if (process.env.FAKE_ACP_STUBBORN_CHILD === '1') {
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000);"], { stdio: 'ignore' });
  if (process.env.FAKE_ACP_TRACE) {
    fs.appendFileSync(process.env.FAKE_ACP_TRACE, `${JSON.stringify({ pid: process.pid, method: 'stubborn-child', params: { pid: stubborn.pid } })}\n`);
  }
}

// FAKE_ACP_IGNORE_EOF stands in for an engine that does not exit on stdin EOF.
if (process.env.FAKE_ACP_IGNORE_EOF === '1') setInterval(() => {}, 1 << 30);
else process.stdin.on('close', () => process.exit(0));
