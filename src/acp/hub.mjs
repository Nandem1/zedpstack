import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { formatBoardText } from '../agents/board.mjs';
import { agentBoard, liveSessionAgentIds, stopSessionAgents } from '../agents/lifecycle.mjs';
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

const CANCEL_PROMPT_WAIT_MS = 10_000;
const CANCEL_WORKERS_WAIT_MS = 10_000;
const DEFAULT_MAX_ENGINES = 8;
const CANCELLED_PERMISSION = { outcome: { outcome: 'cancelled' } };
const ENGINE_LOST_TEXT = 'El engine anterior terminó y la conversación anterior se perdió. Se inicia un engine nuevo.';

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref();
});

function maxEngines(env) {
  const n = Number.parseInt(env.ZEDPSTACK_ACP_MAX_ENGINES ?? '', 10);
  return n > 0 ? n : DEFAULT_MAX_ENGINES;
}

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
 * A session's `turn` is `{ startedAt, controller, promptPromise, cancelling }` while a
 * prompt is open and null otherwise; `cancelling` is the one cancel every
 * `session/cancel` for that turn joins.
 *
 * @param {{ zed: { request: Function, notify?: Function }, env?: object, spawnEngine?: typeof startEngine, log?: (line: string) => void }} opts
 */
export function createHub({
  zed,
  env = process.env,
  spawnEngine = startEngine,
  log = (line) => process.stderr.write(`[zedpstack-acp] ${line}\n`),
}) {
  const sessions = new Map();
  const engineCap = maxEngines(env);
  let clientCapabilities = {};
  let shutdownPromise = null;

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

  // Detaching first tells the exit watcher in startEngineNow that this death was ours.
  async function stopEngine(session) {
    const eng = session.engine;
    if (!eng) return;
    session.engine = null;
    await eng.kill().catch(() => {});
  }

  const engineAlive = (session) => Boolean(session.engine && !session.engine.dead);

  function evictIdleEngines() {
    const alive = [...sessions.values()].filter(engineAlive);
    const excess = alive.length - engineCap + 1;
    if (excess <= 0) return;
    const idle = alive.filter((s) => !s.turn).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const victim of idle.slice(0, excess)) {
      log(`engine cap ${engineCap}: stopping the idle engine of ${victim.sessionId}`);
      victim.engineLost = true;
      stopEngine(victim);
    }
  }

  // Serialized per session: two overlapping starts would orphan the first engine.
  function startSessionEngine(session, runtime) {
    session.starting = (session.starting ?? Promise.resolve()).then(() => startEngineNow(session, runtime));
    return session.starting;
  }

  async function startEngineNow(session, runtime) {
    if (session.closed) return;
    session.runtime = runtime;
    await stopEngine(session);
    session.engineLost = false;
    session.childCommands = [];
    session.primed = false;
    evictIdleEngines();
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
      if (session.closed) {
        await engine.kill();
        return;
      }
      session.engine = engine;
      engine.exited.then(() => {
        if (session.engine !== engine) return;
        session.engine = null;
        session.engineLost = true;
      });
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
      const forwarded = zed.request(method, { ...params, sessionId: session.sessionId }).catch((e) => {
        throw Object.assign(new Error(e.message ?? 'Zed client error'), { rpc: e.rpc ?? -32603 });
      });
      if (method !== 'session/request_permission') return forwarded;
      if (session.turn?.cancelling) return CANCELLED_PERMISSION;
      let cancel;
      const cancelled = new Promise((resolve) => {
        cancel = () => resolve(CANCELLED_PERMISSION);
      });
      session.pendingPermissions.add(cancel);
      try {
        return await Promise.race([forwarded, cancelled]);
      } finally {
        session.pendingPermissions.delete(cancel);
      }
    });
  }

  function cancelPendingPermissions(session) {
    for (const cancel of session.pendingPermissions) cancel();
  }

  /** Every call for one turn returns the same promise; with no open turn it is a no-op. */
  function cancelTurn(session) {
    const { turn } = session;
    if (!turn) return Promise.resolve();
    turn.cancelling ??= runCancel(session, turn);
    return turn.cancelling;
  }

  async function runCancel(session, turn) {
    const engine = session.engine;
    if (engine?.peer && !engine.dead) {
      engine.peer.notify('session/cancel', { sessionId: engine.childSessionId });
    }
    turn.controller.abort();
    const stopTurnWorkers = () => stopSessionAgents({
      repo: session.repo,
      sessionId: session.sessionId,
      sinceMs: turn.startedAt,
    }).catch(() => []);
    const stopping = [stopTurnWorkers()];
    cancelPendingPermissions(session);
    if (turn.promptPromise) {
      await Promise.race([turn.promptPromise.catch(() => {}), delay(CANCEL_PROMPT_WAIT_MS)]);
    }
    // A spawn_agent the engine was serving when the cancel arrived lands after the first pass.
    stopping.push(stopTurnWorkers());
    const ids = (await Promise.all(stopping)).flat();
    if (ids.length) {
      await Promise.race([session.cards.whenFinished(ids), delay(CANCEL_WORKERS_WAIT_MS)]);
    }
  }

  async function reportEngineDeath(session, engine) {
    const { code, signal } = await Promise.race([engine.exited, delay(2000).then(() => ({}))]);
    if (session.engine === engine) {
      session.engine = null;
      session.engineLost = true;
    }
    const how = signal ? `señal ${signal}` : `código ${code ?? 'desconocido'}`;
    const tail = engine.stderrTail(10);
    notifyZed({
      sessionId: session.sessionId,
      update: agentMessageChunk(
        `El engine ${session.runtime} terminó durante el turno (${how}).`
          + (tail ? `\nÚltimas líneas de stderr:\n${tail}` : '')
          + '\nEl próximo mensaje inicia un engine nuevo, sin la conversación anterior.',
      ),
    });
    return { stopReason: 'refusal' };
  }

  async function runTurn(session, turn, params, text) {
    if (!engineAlive(session)) {
      if (session.engineLost) {
        notifyZed({ sessionId: session.sessionId, update: agentMessageChunk(ENGINE_LOST_TEXT) });
      }
      await startSessionEngine(session, session.runtime);
    }
    if (turn.cancelling) {
      await turn.cancelling;
      return { stopReason: 'cancelled' };
    }
    if (!engineAlive(session)) {
      notifyZed({
        sessionId: session.sessionId,
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

    const { engine } = session;
    turn.promptPromise = engine.peer.request('session/prompt', { sessionId: engine.childSessionId, prompt });
    const aborted = new Promise((resolve) => {
      turn.controller.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
    });
    const outcome = await Promise.race([
      turn.promptPromise.then((result) => ({ result }), (error) => ({ error })),
      aborted,
    ]);
    if (turn.cancelling) {
      await turn.cancelling;
      return { stopReason: 'cancelled' };
    }
    if (session.closed) return { stopReason: 'cancelled' };
    if (outcome.error) {
      // The closed stream can reject the prompt before the process reports its exit.
      if (!engine.dead && outcome.error.rpc === -32000) await Promise.race([engine.exited, delay(2000)]);
      if (engine.dead) return reportEngineDeath(session, engine);
      throw outcome.error;
    }
    return outcome.result;
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
          sessionCapabilities: { close: {} },
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
        turn: null,
        lastUsed: Date.now(),
        engineLost: false,
        starting: null,
        closed: false,
        pendingPermissions: new Set(),
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

      if (session.turn) {
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

      const turn = { startedAt: Date.now(), controller: new AbortController(), promptPromise: null, cancelling: null };
      session.turn = turn;
      session.lastUsed = turn.startedAt;
      try {
        return await runTurn(session, turn, params, text);
      } finally {
        session.turn = null;
        session.lastUsed = Date.now();
      }
    },

    // ACP unstable: Zed may close a thread without telling us, so sessions also end at shutdown.
    async 'session/close'(params) {
      const session = getHubSession(params.sessionId);
      if (session) await closeSession(session);
      return {};
    },
  };

  async function closeSession(session) {
    sessions.delete(session.sessionId);
    session.closed = true;
    session.cards.dispose();
    cancelPendingPermissions(session);
    await stopEngine(session);
  }

  const notify = (msg) => {
    if (msg.method !== 'session/cancel') return Promise.resolve();
    const session = getHubSession(msg.params?.sessionId);
    return session ? cancelTurn(session) : Promise.resolve();
  };

  /** Ends engines and card watchers; workers are detached on purpose (D-03) and keep running. */
  function shutdown() {
    shutdownPromise ??= (async () => {
      const all = [...sessions.values()];
      for (const session of all) {
        let left = [];
        try {
          left = liveSessionAgentIds({ repo: session.repo, sessionId: session.sessionId });
        } catch {
          /* the repo may be gone */
        }
        if (left.length) log(`${session.sessionId}: workers left running: ${left.join(', ')}`);
      }
      await Promise.all(all.map(closeSession));
    })();
    return shutdownPromise;
  }

  return { handle, notify, shutdown };
}
