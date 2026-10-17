import path from 'node:path';
import { formatBoardText } from '../agents/board.mjs';
import { agentBoard } from '../agents/lifecycle.mjs';
import { ZEDPSTACK_VERSION } from '../constants.mjs';
import { parsePromptCommand } from './commands.mjs';
import { startEngine } from './engine.mjs';
import {
  loadPrefs,
  mergeCommands,
  mergeOptions,
  parseRuntimeSwitch,
  routeOption,
  runtimeOption,
  savePrefs,
  ZP_RUNTIME_ID,
} from './options.mjs';
import { createSessionStore, runSpawnTurn } from './server.mjs';
import { acpStreamMode } from './updates.mjs';

function agentMessageChunk(text) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function promptTextFromBlocks(prompt) {
  return (prompt ?? [])
    .filter((b) => b?.type === 'text' && b.text != null)
    .map((b) => b.text)
    .join('\n');
}

/**
 * @param {{ zed: { request: Function, notify?: Function }, env?: object, spawnEngine?: typeof startEngine }} opts
 */
export function createHub({ zed, env = process.env, spawnEngine = startEngine }) {
  const sessions = createSessionStore();
  const engines = new Map();
  let clientCapabilities = {};
  let shuttingDown = false;

  const notifyZed = (params) => zed.notify?.(params);

  function getHubSession(outerSessionId) {
    const base = sessions.get(outerSessionId);
    if (!base) return null;
    const extra = engines.get(outerSessionId);
    return extra ? { ...base, ...extra } : null;
  }

  function mergedConfigFor(session) {
    const zp = runtimeOption(session.runtime, ['claude', 'codex', 'cursor']);
    zp.currentValue = session.runtime;
    return mergeOptions(zp, session.childConfigOptions ?? []);
  }

  async function applySavedPrefsToChild(session) {
    if (!session.engine?.peer || session.engine.dead) return;
    const prefs = loadPrefs(env);
    const saved = prefs.perRuntime[session.runtime] ?? {};
    for (const [configId, value] of Object.entries(saved)) {
      if (configId === ZP_RUNTIME_ID) continue;
      try {
        const res = await session.engine.peer.request('session/set_config_option', {
          sessionId: session.engine.childSessionId,
          configId,
          value,
        });
        session.childConfigOptions = res.configOptions ?? session.childConfigOptions;
      } catch {
        /* */
      }
    }
  }

  async function stopEngine(session) {
    const eng = session.engine;
    if (!eng) return;
    await eng.kill().catch(() => {});
    session.engine = null;
  }

  async function startSessionEngine(session, runtime) {
    session.runtime = runtime;
    await stopEngine(session);
    try {
      const engine = await spawnEngine({
        runtime,
        cwd: session.repo,
        clientCapabilities,
        mcpServers: [],
        env,
      });
      session.engine = engine;
      session.childConfigOptions = engine.newSessionResult.configOptions ?? [];
      wireEnginePeer(session);
      await applySavedPrefsToChild(session);
      session.engineError = null;
    } catch (e) {
      session.engine = null;
      session.childConfigOptions = [];
      session.engineError = e.message ?? String(e);
    }
  }

  function wireEnginePeer(session) {
    const peer = session.engine?.peer;
    if (!peer) return;

    peer.onNotification((method, params) => {
      if (method !== 'session/update') return;
      const update = params.update ?? params;
      let outUpdate = update;
      if (update.sessionUpdate === 'config_option_update') {
        const zp = runtimeOption(session.runtime);
        zp.currentValue = session.runtime;
        outUpdate = {
          ...update,
          configOptions: mergeOptions(zp, update.configOptions ?? []),
        };
        session.childConfigOptions = update.configOptions ?? session.childConfigOptions;
      }
      notifyZed({
        sessionId: session.sessionId,
        update: outUpdate,
      });
    });

    peer.onRequest(async (method, params) => {
      const outerParams = { ...params, sessionId: session.sessionId };
      try {
        return await zed.request(method, outerParams);
      } catch (e) {
        throw Object.assign(new Error(e.message ?? 'Zed client error'), { rpc: e.rpc ?? -32603 });
      }
    });
  }

  async function switchRuntime(session, runtime) {
    const prefs = loadPrefs(env);
    prefs.lastRuntime = runtime;
    savePrefs(prefs, env);
    await startSessionEngine(session, runtime);
    if (session.engineError) {
      notifyZed({
        sessionId: session.sessionId,
        update: agentMessageChunk(`No se pudo iniciar el engine ${runtime}: ${session.engineError}`),
      });
    } else {
      notifyZed({
        sessionId: session.sessionId,
        update: agentMessageChunk(`Orquestador: ${runtime}. La conversación se reinicia.`),
      });
    }
    notifyZed({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: mergedConfigFor(session),
      },
    });
  }

  const handle = {
    async initialize(params) {
      clientCapabilities = params.clientCapabilities ?? {};
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
    },

    async 'session/new'(params) {
      const cwd = params.cwd ?? process.cwd();
      const repo = path.resolve(cwd);
      const sessionId = sessions.create(repo);

      const prefs = loadPrefs(env);
      const runtime = prefs.lastRuntime ?? 'claude';

      const session = {
        sessionId,
        repo,
        runtime,
        engine: null,
        childConfigOptions: [],
        engineError: null,
        childCommands: [],
      };
      engines.set(sessionId, session);

      await startSessionEngine(session, runtime);

      const configOptions = mergedConfigFor(session);
      if (session.engineError) {
        setImmediate(() => {
          notifyZed({
            sessionId,
            update: agentMessageChunk(`No se pudo iniciar el engine: ${session.engineError}`),
          });
        });
      }

      const result = { sessionId, configOptions };
      setImmediate(() => {
        const cmds = mergeCommands(session.childCommands);
        notifyZed({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: cmds,
          },
        });
      });
      return result;
    },

    async 'session/set_config_option'(params) {
      const session = getHubSession(params.sessionId);
      if (!session) throw Object.assign(new Error(`unknown session: ${params.sessionId}`), { rpc: -32602 });

      if (params.configId === ZP_RUNTIME_ID) {
        await switchRuntime(session, params.value);
        return { configOptions: mergedConfigFor(session) };
      }

      const prefs = loadPrefs(env);
      if (!prefs.perRuntime[session.runtime]) prefs.perRuntime[session.runtime] = {};
      prefs.perRuntime[session.runtime][params.configId] = params.value;
      savePrefs(prefs, env);

      if (routeOption(params.configId) === 'child' && session.engine?.peer && !session.engine.dead) {
        const res = await session.engine.peer.request('session/set_config_option', {
          sessionId: session.engine.childSessionId,
          configId: params.configId,
          value: params.value,
        });
        session.childConfigOptions = res.configOptions ?? session.childConfigOptions;
      }

      return { configOptions: mergedConfigFor(session) };
    },

    async 'session/set_mode'(params) {
      const session = getHubSession(params.sessionId);
      if (!session) throw Object.assign(new Error(`unknown session: ${params.sessionId}`), { rpc: -32602 });
      if (!session.engine?.peer || session.engine.dead) {
        throw Object.assign(new Error('engine not available'), { rpc: -32602 });
      }
      return session.engine.peer.request('session/set_mode', {
        ...params,
        sessionId: session.engine.childSessionId,
      });
    },

    async 'session/prompt'(params) {
      const session = getHubSession(params.sessionId);
      if (!session) throw Object.assign(new Error(`unknown session: ${params.sessionId}`), { rpc: -32602 });

      const storeEntry = sessions.get(params.sessionId);
      if (storeEntry?.activeTurn) {
        throw Object.assign(new Error('turn in progress'), { rpc: -32602 });
      }

      const text = promptTextFromBlocks(params.prompt);
      const runtimeSwitch = parseRuntimeSwitch(text);
      if (runtimeSwitch) {
        await switchRuntime(session, runtimeSwitch);
        return { stopReason: 'end_turn' };
      }

      const command = parsePromptCommand(text);
      const streamMode = acpStreamMode(env);
      const turnController = new AbortController();
      sessions.setActiveTurn(params.sessionId, { agentIds: [], controller: turnController });

      if (command.type === 'board') {
        const rows = agentBoard({ repo: session.repo, recentMinutes: 30 });
        notifyZed({
          sessionId: params.sessionId,
          update: agentMessageChunk(formatBoardText(rows)),
        });
        sessions.setActiveTurn(params.sessionId, null);
        return { stopReason: 'end_turn' };
      }

      if (command.type === 'spawn') {
        try {
          await runSpawnTurn({
            sessions,
            sessionId: params.sessionId,
            repo: session.repo,
            command,
            notify: (p) => notifyZed(p),
            signal: turnController.signal,
            streamMode,
          });
          sessions.setActiveTurn(params.sessionId, null);
          if (turnController.signal.aborted) return { stopReason: 'cancelled' };
          return { stopReason: 'end_turn' };
        } catch (e) {
          sessions.setActiveTurn(params.sessionId, null);
          if (turnController.signal.aborted) return { stopReason: 'cancelled' };
          throw e;
        }
      }

      if (!session.engine?.peer || session.engine.dead) {
        sessions.setActiveTurn(params.sessionId, null);
        notifyZed({
          sessionId: params.sessionId,
          update: agentMessageChunk(
            session.engineError ? `Engine no disponible: ${session.engineError}` : 'Engine no disponible.',
          ),
        });
        return { stopReason: 'end_turn' };
      }

      sessions.setActiveTurn(params.sessionId, { child: true });
      try {
        const result = await session.engine.peer.request('session/prompt', {
          sessionId: session.engine.childSessionId,
          prompt: params.prompt,
        });
        sessions.setActiveTurn(params.sessionId, null);
        return result;
      } catch (e) {
        sessions.setActiveTurn(params.sessionId, null);
        throw e;
      }
    },
  };

  const notify = async (msg) => {
    if (msg.method !== 'session/cancel') return;
    const session = getHubSession(msg.params?.sessionId);
    const storeEntry = sessions.get(msg.params?.sessionId);
    const turn = storeEntry?.activeTurn;
    if (turn?.controller) {
      turn.controller.abort();
      const ids = turn.agentIds ?? [];
      const { closeAgent } = await import('../agents/lifecycle.mjs');
      await Promise.all(ids.map((id) => closeAgent({ repo: session.repo, id }).catch(() => {})));
      return;
    }
    if (session?.engine?.peer && !session.engine.dead) {
      session.engine.peer.notify('session/cancel', {
        sessionId: session.engine.childSessionId,
      });
    }
  };

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const session of engines.values()) {
      await stopEngine(session);
    }
    engines.clear();
  }

  return { handle, notify, shutdown };
}
