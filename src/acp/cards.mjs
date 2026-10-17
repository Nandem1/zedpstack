import { listAgentIds, loadAgent } from '../agents/store.mjs';
import { followAgent } from './follow.mjs';
import { createWorkerUpdateSink, workerTitle } from './updates.mjs';

/**
 * One card per worker whose origin is this outer session, whoever spawned it
 * (the engine's MCP child, a CLI run with the same env). The store is the only
 * source: new agents are found by polling the agents directory.
 *
 * @param {{ repo: string, sessionId: string, notify: (params: object) => void, pollMs?: number, streamMode?: 'content'|'terminal' }} opts
 */
export function createWorkerCards({ repo, sessionId, notify, pollMs = 300, streamMode = 'content' }) {
  /** @type {Map<string, AbortController>} */
  const attached = new Map();
  /** @type {Map<string, Promise<unknown>>} settles once the card closed or was dropped */
  const finished = new Map();
  // origin lives in agent.json, which is never rewritten, so a foreign agent stays foreign.
  const foreign = new Set();
  let timer = null;
  let disposed = false;

  const ownsAgent = (spec) => spec.origin?.frontend === 'acp' && spec.origin.sessionId === sessionId;
  // A sink's throttle timer can still fire once after dispose; the client must not hear it.
  const send = (params) => {
    if (!disposed) notify(params);
  };

  function attach(view) {
    const { spec } = view;
    const controller = new AbortController();
    attached.set(spec.id, controller);
    const sink = createWorkerUpdateSink({
      notify: send,
      sessionId,
      repo,
      agentId: spec.id,
      title: workerTitle({
        description: spec.description,
        role: spec.role,
        model: spec.binding.model,
        runtime: spec.binding.runtime,
      }),
      streamMode,
    });
    controller.signal.addEventListener('abort', () => sink.dispose(), { once: true });
    sink.emitStart();
    finished.set(spec.id, followAgent(repo, spec.id, (event) => sink.onFollowEvent(event), { signal: controller.signal, intervalMs: pollMs })
      .then(() => (controller.signal.aborted ? null : sink.finish()))
      .catch(() => {}));
  }

  function resync() {
    if (disposed) return;
    let ids;
    try {
      ids = listAgentIds(repo);
    } catch {
      return;
    }
    for (const id of ids) {
      if (attached.has(id) || foreign.has(id)) continue;
      let view;
      try {
        view = loadAgent(repo, id);
      } catch {
        continue;
      }
      if (ownsAgent(view.spec)) attach(view);
      else foreign.add(id);
    }
  }

  return {
    start() {
      if (timer || disposed) return;
      resync();
      timer = setInterval(resync, pollMs);
      timer.unref();
    },
    resync,
    /** Resolves once every card among `ids` sent its terminal update (or the cards were disposed). */
    whenFinished(ids) {
      resync();
      return Promise.all(ids.map((id) => finished.get(id)));
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      timer = null;
      for (const controller of attached.values()) controller.abort();
      return Promise.all(finished.values()).then(() => {
        attached.clear();
        finished.clear();
        foreign.clear();
      });
    },
  };
}
