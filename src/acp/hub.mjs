import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { formatBoardText } from '../agents/board.mjs';
import { agentBoard } from '../agents/lifecycle.mjs';
import { ZEDPSTACK_VERSION } from '../constants.mjs';
import { orchestratorPrompt } from '../orchestratorPrompt.mjs';
import { createWorkerCards } from './cards.mjs';
import { isBoardCommand, isChildCommand } from './commands.mjs';
import { engineMcpServers, startEngine } from './engine.mjs';
import {
  childOptionState,
  loadPrefs,
  mergeCommands,
  mergeOptions,
  parseRuntimeSwitch,
  routeOption,
  runtimeOption,
  savePrefs,
  ZP_RUNTIME_ID,
} from './options.mjs';
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
  const sessions = new Map();
  let clientCapabilities = {};
  let shuttingDown = false;

  const notifyZed = (params) => zed.notify?.(params);

  function getHubSession(outerSessionId) {
    return sessions.get(outerSessionId) ?? null;
  }

  function mergedConfigFor(session) {
    const zp = runtimeOption(session.runtime, ['claude', 'codex', 'cursor']);
    zp.currentValue = session.runtime;
    return mergeOptions(zp, session.childOptions.configOptions);
  }

  function announceCommands(session) {
    if (!session.commandsAnnounced) return;
    notifyZed({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: mergeCommands(session.childCommands),
      },
    });
  }

  async function setChildOption(session, configId, value) {
    const route = session.childOptions.legacyRoutes[configId];
    const params = { sessionId: session.engine.childSessionId };
    if (route) params[route.valueKey] = value;
    else Object.assign(params, { configId, value });
    const result = await session.engine.peer.request(route?.method ?? 'session/set_config_option', params);
    if (result.configOptions != null) {
      session.childOptions = childOptionState(result);
    } else if (route) {
      session.childOptions.configOptions = session.childOptions.configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option);
    }
  }

  async function applySavedPrefsToChild(session) {
    if (!session.engine?.peer || session.engine.dead) return;
    const prefs = loadPrefs(env);
    const saved = prefs.perRuntime[session.runtime] ?? {};
    for (const [configId, value] of Object.entries(saved)) {
      if (configId === ZP_RUNTIME_ID) continue;
      try {
        await setChildOption(session, configId, value);
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
    session.childCommands = [];
    session.primed = false;
    try {
      const engine = await spawnEngine({
        runtime,
        cwd: session.repo,
        clientCapabilities,
        mcpServers: engineMcpServers({
          clientServers: session.clientMcpServers,
          sessionId: session.sessionId,
          repo: session.repo,
        }),
        env,
      });
      session.engine = engine;
      session.childOptions = childOptionState(engine.newSessionResult);
      session.childCommands = engine.initialCommands ?? [];
      wireEnginePeer(session);
      await applySavedPrefsToChild(session);
      session.engineError = null;
    } catch (e) {
      session.engine = null;
      session.childOptions = childOptionState();
      session.engineError = e.message ?? String(e);
    }
    announceCommands(session);
  }

  function wireEnginePeer(session) {
    const peer = session.engine?.peer;
    if (!peer) return;

    peer.onNotification((method, params) => {
      if (method !== 'session/update') return;
      const update = params.update ?? params;
      let outUpdate = update;
      if (update.sessionUpdate === 'available_commands_update') {
        session.childCommands = update.availableCommands ?? [];
        if (!session.commandsAnnounced) return;
        outUpdate = {
          ...update,
          availableCommands: mergeCommands(session.childCommands),
        };
      } else if (update.sessionUpdate === 'config_option_update') {
        session.childOptions = childOptionState(update);
        outUpdate = {
          ...update,
          configOptions: mergedConfigFor(session),
        };
      } else if (update.sessionUpdate === 'current_mode_update' || update.sessionUpdate === 'current_model_update') {
        const configId = update.sessionUpdate === 'current_mode_update' ? 'mode' : 'model';
        if (session.childOptions.legacyRoutes[configId]) {
          const value = configId === 'mode' ? update.currentModeId : update.currentModelId;
          session.childOptions.configOptions = session.childOptions.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: value } : option);
          notifyZed({
            sessionId: session.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: mergedConfigFor(session) },
          });
        }
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
      const sessionId = `sess-${randomBytes(8).toString('hex')}`;

      const prefs = loadPrefs(env);
      const runtime = prefs.lastRuntime ?? 'claude';

      const session = {
        sessionId,
        repo,
        runtime,
        clientMcpServers: params.mcpServers ?? [],
        engine: null,
        childOptions: childOptionState(),
        engineError: null,
        childCommands: [],
        commandsAnnounced: false,
        primed: false,
        turnActive: false,
        cards: createWorkerCards({ repo, sessionId, notify: notifyZed, streamMode: acpStreamMode(env) }),
      };
      sessions.set(sessionId, session);
      session.cards.start();

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
      for (const field of ['models', 'modes']) {
        const value = session.engine?.newSessionResult[field];
        if (value !== undefined) result[field] = value;
      }
      setImmediate(() => {
        session.commandsAnnounced = true;
        announceCommands(session);
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

      if (routeOption(params.configId) === 'child' && session.engine?.peer && !session.engine.dead) {
        await setChildOption(session, params.configId, params.value);
      }

      const prefs = loadPrefs(env);
      if (!prefs.perRuntime[session.runtime]) prefs.perRuntime[session.runtime] = {};
      prefs.perRuntime[session.runtime][params.configId] = params.value;
      savePrefs(prefs, env);

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

      if (session.turnActive) {
        throw Object.assign(new Error('turn in progress'), { rpc: -32602 });
      }
      session.cards.resync();

      const text = promptTextFromBlocks(params.prompt);
      const runtimeSwitch = parseRuntimeSwitch(text);
      if (runtimeSwitch) {
        await switchRuntime(session, runtimeSwitch);
        return { stopReason: 'end_turn' };
      }

      if (isBoardCommand(text)) {
        const rows = agentBoard({ repo: session.repo, recentMinutes: 30 });
        notifyZed({
          sessionId: params.sessionId,
          update: agentMessageChunk(formatBoardText(rows)),
        });
        return { stopReason: 'end_turn' };
      }

      if (!session.engine?.peer || session.engine.dead) {
        notifyZed({
          sessionId: params.sessionId,
          update: agentMessageChunk(
            session.engineError ? `Engine no disponible: ${session.engineError}` : 'Engine no disponible.',
          ),
        });
        return { stopReason: 'end_turn' };
      }

      let prompt = params.prompt;
      if (!session.primed && !isChildCommand(text, session.childCommands)) {
        prompt = [{ type: 'text', text: orchestratorPrompt() }, ...(params.prompt ?? [])];
        session.primed = true;
      }

      session.turnActive = true;
      try {
        return await session.engine.peer.request('session/prompt', {
          sessionId: session.engine.childSessionId,
          prompt,
        });
      } finally {
        session.turnActive = false;
      }
    },
  };

  const notify = async (msg) => {
    if (msg.method !== 'session/cancel') return;
    const session = getHubSession(msg.params?.sessionId);
    if (session?.engine?.peer && !session.engine.dead) {
      session.engine.peer.notify('session/cancel', {
        sessionId: session.engine.childSessionId,
      });
    }
  };

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const session of sessions.values()) {
      session.cards.dispose();
      await stopEngine(session);
    }
    sessions.clear();
  }

  return { handle, notify, shutdown };
}
