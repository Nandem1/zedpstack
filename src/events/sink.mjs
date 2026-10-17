import fs from 'node:fs';
import path from 'node:path';
import {
  formatHumanProgressEvent,
  shouldUseHumanProgress,
} from '../progressUi.mjs';
import { appendProgressLog } from '../progressLog.mjs';

/**
 * Append-only event stream + optional tee for realtime observability.
 */
const STREAM_EVENT_TYPES = new Set(['worker.output', 'worker.stderr']);

export class EventSink {
  #eventsPath;
  #runRoot;
  #tee;
  #persistWorkerStream;
  #humanProgress;

  constructor(
    runRoot,
    { tee = false, persistWorkerStream = false, humanProgress = 'auto' } = {},
  ) {
    this.#eventsPath = path.join(runRoot, 'events.jsonl');
    this.#tee = tee;
    this.#persistWorkerStream = persistWorkerStream;
    this.#humanProgress = humanProgress;
    fs.mkdirSync(runRoot, { recursive: true });
    if (!fs.existsSync(this.#eventsPath)) {
      fs.writeFileSync(this.#eventsPath, '');
    }
    this.#runRoot = runRoot;
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
    appendProgressLog(this.#runRoot, event);

    if (this.#tee) {
      const human = formatHumanProgressEvent(event);
      if (shouldUseHumanProgress({ teeHuman: this.#humanProgress }) && human) {
        process.stderr.write(`${human}\n`);
      } else {
        process.stderr.write(`[zedpstack] ${line}`);
      }
    }
    return event;
  }
}
