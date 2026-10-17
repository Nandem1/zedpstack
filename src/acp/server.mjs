import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import { formatBoardText } from '../agents/board.mjs';
import { agentBoard, closeAgent, spawnAgent } from '../agents/lifecycle.mjs';
import { ZEDPSTACK_VERSION } from '../constants.mjs';
import { AVAILABLE_COMMANDS, parsePromptCommand, USAGE_TEXT } from './commands.mjs';
import { followAgent } from './follow.mjs';
import { acpStreamMode, createWorkerUpdateSink, workerTitle } from './updates.mjs';

const err = (code, message) => ({ code, message });

function newSessionId() {
  return `sess-${randomBytes(8).toString('hex')}`;
}

function promptTextFromBlocks(prompt) {
  return (prompt ?? [])
    .filter((b) => b?.type === 'text' && b.text != null)
    .map((b) => b.text)
    .join('\n');
}

function agentMessageChunk(text) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

export function createSessionStore() {
  const sessions = new Map();
  return {
    create(repo) {
      const sessionId = newSessionId();
      sessions.set(sessionId, { sessionId, repo: path.resolve(repo), activeTurn: null });
      return sessionId;
    },
    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    setActiveTurn(sessionId, turn) {
      const s = sessions.get(sessionId);
      if (s) s.activeTurn = turn;
    },
  };
}

export async function runSpawnTurn({ sessions, sessionId, repo, command, notify, signal, streamMode }) {
  const workers = [];
  for (let i = 0; i < command.count; i += 1) {
    const spawned = spawnAgent({
      repo,
      role: command.role,
      prompt: command.prompt,
      readonly: true,
      description: command.count > 1 ? `${command.role} #${i + 1}` : command.role,
    });
    workers.push(spawned);
  }

  const agentIds = workers.map((w) => w.agent_id);
  const turn = sessions.get(sessionId)?.activeTurn;
  if (turn) turn.agentIds = agentIds;

  const sinks = workers.map((w) =>
    createWorkerUpdateSink({
      notify,
      sessionId,
      repo,
      agentId: w.agent_id,
      title: workerTitle(w),
      streamMode,
    }),
  );
  for (const s of sinks) s.emitStart();

  await Promise.all(
    workers.map((w, i) =>
      followAgent(repo, w.agent_id, (ev) => sinks[i].onFollowEvent(ev), { signal, intervalMs: 100 }),
    ),
  );

  const outcomes = await Promise.all(sinks.map((s) => s.finish()));
  return { agentIds, outcomes };
}

export async function handleAcpRequest(msg, ctx) {
  const { method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: {},
        },
        agentInfo: { name: 'zedpstack', version: ZEDPSTACK_VERSION },
        authMethods: [],
      };
    case 'session/new': {
      const cwd = params.cwd ?? process.cwd();
      const sessionId = ctx.sessions.create(cwd);
      return { sessionId };
    }
    case 'session/prompt': {
      const session = ctx.sessions.get(params.sessionId);
      if (!session) throw Object.assign(new Error(`unknown session: ${params.sessionId}`), { rpc: -32602 });
      const text = promptTextFromBlocks(params.prompt);
      const command = parsePromptCommand(text);
      const streamMode = acpStreamMode(ctx.env);
      const turnController = new AbortController();
      ctx.sessions.setActiveTurn(params.sessionId, { agentIds: [], controller: turnController });

      if (command.type === 'usage') {
        ctx.notify({
          sessionId: params.sessionId,
          update: agentMessageChunk(USAGE_TEXT),
        });
        ctx.sessions.setActiveTurn(params.sessionId, null);
        return { stopReason: 'end_turn' };
      }

      if (command.type === 'board') {
        const rows = agentBoard({ repo: session.repo, recentMinutes: 30 });
        ctx.notify({
          sessionId: params.sessionId,
          update: agentMessageChunk(formatBoardText(rows)),
        });
        ctx.sessions.setActiveTurn(params.sessionId, null);
        return { stopReason: 'end_turn' };
      }

      try {
        await runSpawnTurn({
          sessions: ctx.sessions,
          sessionId: params.sessionId,
          repo: session.repo,
          command,
          notify: (p) => ctx.notify(p),
          signal: turnController.signal,
          streamMode,
        });
        ctx.sessions.setActiveTurn(params.sessionId, null);
        if (turnController.signal.aborted) return { stopReason: 'cancelled' };
        return { stopReason: 'end_turn' };
      } catch (e) {
        ctx.sessions.setActiveTurn(params.sessionId, null);
        if (turnController.signal.aborted) return { stopReason: 'cancelled' };
        throw e;
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
  }
}

export async function handleAcpNotification(msg, ctx) {
  if (msg.method !== 'session/cancel') return;
  const session = ctx.sessions.get(msg.params?.sessionId);
  if (!session?.activeTurn) return;
  session.activeTurn.controller?.abort();
  const ids = session.activeTurn.agentIds ?? [];
  await Promise.all(ids.map((id) => closeAgent({ repo: session.repo, id }).catch(() => {})));
}

export function startAcpServer({ input = process.stdin, output = process.stdout, env = process.env, sessions = createSessionStore() } = {}) {
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const notify = (params) => write({ jsonrpc: '2.0', method: 'session/update', params });
  const ctx = { sessions, env, notify };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: err(-32700, 'Parse error') });
      return;
    }
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (!isRequest) {
      await handleAcpNotification(msg, ctx);
      return;
    }
    try {
      const result = await handleAcpRequest(msg, { ...ctx, notify });
      write({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'session/new' && result?.sessionId) {
        const { sessionId } = result;
        queueMicrotask(() => {
          notify({
            sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: AVAILABLE_COMMANDS,
            },
          });
        });
      }
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: err(e.rpc ?? -32603, e.message) });
    }
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
