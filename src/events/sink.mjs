import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only event stream + optional tee for realtime observability.
 */
const STREAM_EVENT_TYPES = new Set(['worker.output', 'worker.stderr']);

export class EventSink {
  #eventsPath;
  #tee;
  #persistWorkerStream;

  constructor(runRoot, { tee = false, persistWorkerStream = false } = {}) {
    this.#eventsPath = path.join(runRoot, 'events.jsonl');
    this.#tee = tee;
    this.#persistWorkerStream = persistWorkerStream;
    fs.mkdirSync(runRoot, { recursive: true });
    if (!fs.existsSync(this.#eventsPath)) {
      fs.writeFileSync(this.#eventsPath, '');
    }
  }

  emit(type, payload = {}) {
    const event = {
      ts: new Date().toISOString(),
      type,
      ...payload,
    };
    const line = `${JSON.stringify(event)}\n`;
    const isStreamChunk = STREAM_EVENT_TYPES.has(type);
    if (!isStreamChunk || this.#persistWorkerStream) {
      fs.appendFileSync(this.#eventsPath, line);
    }
    if (this.#tee) {
      process.stderr.write(`[zedpstack] ${line}`);
    }
    return event;
  }
}
