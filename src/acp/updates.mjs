import { agentResult } from '../agents/lifecycle.mjs';
import { modelLabel } from '../modelCheck.mjs';

export const THROTTLE_MS = 250;
const MAX_CONTENT_LINES = 200;
const WORKER_START_PLACEHOLDER = 'Iniciando worker…';

/** @type {Record<'content'|'terminal', string>} */
export const STREAM_TOOL_KIND = {
  content: 'other',
  terminal: 'execute',
};

const STATUS_MAP = {
  starting: 'pending',
  queued: 'pending',
  running: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  stopped: 'failed',
};

export function acpStreamMode(env = process.env) {
  const v = (env.ZEDPSTACK_ACP_STREAM ?? 'content').toLowerCase();
  return v === 'terminal' ? 'terminal' : 'content';
}

export function toolCallIdForAgent(agentId) {
  return `zp-${agentId}`;
}

/** `summary` is an agent summary; before the worker reports its model it may lack `model_check`. */
export function workerTitle(summary) {
  const desc = summary.description ?? summary.role ?? 'worker';
  const model = summary.model_check ? modelLabel(summary.model_check) : summary.model;
  return `${desc} · ${model} (${summary.runtime})`;
}

function textContentBlock(text) {
  return [{ type: 'content', content: { type: 'text', text } }];
}

function isJsonStdoutLine(line) {
  const t = line.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

function humanStdoutLines(stdoutChunks) {
  const stdoutText = stdoutChunks.join('');
  const stdoutLines = stdoutText ? stdoutText.split('\n').filter((l, i, a) => l || i < a.length - 1) : [];
  return stdoutLines.filter((line) => !isJsonStdoutLine(line));
}

function buildLiveText(activityLines, stdoutChunks, { capLines }) {
  const lines = [...activityLines, ...humanStdoutLines(stdoutChunks)];
  const capped = capLines ? lines.slice(-MAX_CONTENT_LINES) : lines;
  return capped.join('\n');
}

function buildCumulativeText(activityLines, stdoutChunks) {
  return buildLiveText(activityLines, stdoutChunks, { capLines: true });
}

function toTerminalOutputData(text) {
  return text.replace(/\n/g, '\r\n');
}

function resultSummaryText(result) {
  const parts = [];
  if (result.text) parts.push(String(result.text).trim());
  if (result.changes?.commit) parts.push(`commit: ${result.changes.commit}`);
  if (result.changes?.files?.length) parts.push(`files:\n${result.changes.files.join('\n')}`);
  if (result.changes?.diffStat) parts.push(`diff: ${result.changes.diffStat}`);
  if (result.error) parts.push(`error: ${result.error}`);
  return parts.join('\n\n') || '(sin resultado)';
}

/**
 * @param {{ notify: (params: object) => void, sessionId: string, repo: string, agentId: string, title: string, streamMode: 'content'|'terminal' }} ctx
 */
export function createWorkerUpdateSink({ notify, sessionId, repo, agentId, title, streamMode }) {
  const toolCallId = toolCallIdForAgent(agentId);
  const activityLines = [];
  const stdoutChunks = [];
  let lastEmit = 0;
  let pendingTimer = null;
  let terminalSourceEmittedLen = 0;
  let sawInProgress = false;
  let lastWorkerStatus = 'starting';

  const sessionUpdate = (update) => notify({ sessionId, update });

  const resolveAcpStatus = (workerStatus) => {
    let acpStatus = STATUS_MAP[workerStatus] ?? 'in_progress';
    if (sawInProgress && acpStatus === 'pending') acpStatus = 'in_progress';
    return acpStatus;
  };

  const emitStart = () => {
    const kind = STREAM_TOOL_KIND[streamMode];
    if (streamMode === 'terminal') {
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind,
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: agentId }],
        _meta: { terminal_info: { terminal_id: agentId, cwd: repo } },
      });
      sawInProgress = true;
      return;
    }
    sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind,
      status: 'pending',
      content: textContentBlock(WORKER_START_PLACEHOLDER),
    });
  };

  const emitProgress = (status, { force = false } = {}) => {
    const now = Date.now();
    const acpStatus = resolveAcpStatus(status);
    if (!force && now - lastEmit < THROTTLE_MS) {
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          emitProgress(status, { force: true });
        }, THROTTLE_MS - (now - lastEmit));
        pendingTimer.unref();
      }
      return;
    }
    lastEmit = now;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }

    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: acpStatus,
    };

    if (streamMode === 'content') {
      const text = buildCumulativeText(activityLines, stdoutChunks);
      if (text) update.content = textContentBlock(text);
    } else {
      const full = buildLiveText(activityLines, stdoutChunks, { capLines: false });
      const slice = full.slice(terminalSourceEmittedLen);
      if (slice) {
        terminalSourceEmittedLen = full.length;
        update._meta = {
          terminal_output: { terminal_id: agentId, data: toTerminalOutputData(slice) },
        };
      }
    }
    sessionUpdate(update);
    if (acpStatus === 'in_progress') sawInProgress = true;
  };

  // A worker already finished when first seen still streams its log as in_progress;
  // only finish() may report the terminal status, so the card closes exactly once.
  const progressStatusForEmit = () => {
    if (sawInProgress || ['in_progress', 'completed', 'failed'].includes(resolveAcpStatus(lastWorkerStatus))) {
      return 'running';
    }
    return lastWorkerStatus;
  };

  const onFollowEvent = (event) => {
    if (event.type === 'activity' && event.line) activityLines.push(event.line);
    if (event.type === 'output' && event.text) stdoutChunks.push(event.text);

    if (event.type === 'status' && event.status) {
      lastWorkerStatus = event.status;
      const mapped = resolveAcpStatus(event.status);
      if (mapped === 'in_progress') sawInProgress = true;
      if (mapped === 'in_progress') {
        emitProgress(event.status, { force: true });
      } else if (mapped === 'pending') {
        emitProgress(event.status);
      } else if (!['completed', 'failed'].includes(mapped)) {
        emitProgress(event.status);
      }
      return;
    }

    if (event.type === 'activity' || event.type === 'output') {
      emitProgress(progressStatusForEmit());
    }
  };

  const finish = async () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (!sawInProgress) {
      sawInProgress = true;
      emitProgress('running', { force: true });
    }
    const result = agentResult({ repo, id: agentId });
    const terminal = ['completed', 'failed', 'stopped'].includes(result.status);
    const acpStatus = STATUS_MAP[result.status] ?? 'failed';
    const summary = resultSummaryText(result);
    // The effective model is only known once the worker reported it, so the card title catches up here.
    const finalTitle = workerTitle(result);
    const retitle = finalTitle !== title ? { title: finalTitle } : {};

    if (streamMode === 'terminal') {
      const summaryData = toTerminalOutputData(
        summary === '(sin resultado)' ? '' : `${summary}\n`,
      );
      if (summaryData) {
        sessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          _meta: { terminal_output: { terminal_id: agentId, data: summaryData } },
        });
      }
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: acpStatus,
        ...retitle,
        _meta: {
          terminal_exit: {
            terminal_id: agentId,
            exit_code: result.status === 'completed' ? 0 : 1,
            signal: null,
          },
        },
      });
    } else {
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: acpStatus,
        ...retitle,
        content: textContentBlock(summary),
      });
    }

    return { sawInProgress, terminal, acpStatus };
  };

  return { emitStart, onFollowEvent, finish };
}

/** @internal test helper */
export function createThrottleGate(ms = THROTTLE_MS) {
  let last = 0;
  let count = 0;
  return {
    tick(force = false) {
      const now = Date.now();
      if (force || now - last >= ms) {
        last = now;
        count += 1;
        return true;
      }
      return false;
    },
    get count() {
      return count;
    },
  };
}
