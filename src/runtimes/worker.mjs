import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildClaudeArgv,
  buildCodexArgv,
  buildCursorArgv,
  workerEnv,
} from '../permissions.mjs';
import {
  accumulateCodexReadSignals,
  detectCodexShellInvocation,
  detectCodexShellMutation,
} from '../shellSignals.mjs';
import { createActivityParser } from './activity.mjs';
import { accumulateStreamSignals, extractStreamText } from './stream.mjs';

/**
 * One adapter per CLI: how to build argv and how to read its output.
 * Every runtime receives the prompt over stdin.
 */
const ADAPTERS = {
  claude: {
    argv: (o) => buildClaudeArgv(o),
    streamJson: true,
  },
  cursor: {
    argv: (o) => buildCursorArgv(o),
    streamJson: true,
  },
  codex: {
    argv: (o) => [...buildCodexArgv({ ...o, resultOutPath: o.lastMessagePath }), '-'],
    streamJson: false,
  },
};

export function adapterFor(runtime) {
  const adapter = ADAPTERS[runtime];
  if (!adapter) throw new Error(`Unsupported runtime: ${runtime}`);
  return adapter;
}

function kill(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Spawn one worker CLI, stream its output to logs and events, write result.json.
 *
 * @param {{
 *   binding: { runtime: string, model: string, permissionProfile: string, effort?: string },
 *   cwd: string,
 *   promptText: string,
 *   workerRoot: string,
 *   timeoutMs: number,
 *   emit?: (type: string, payload: object) => void,
 *   eventBase?: object,
 *   extraReadDirs?: string[],
 *   allowedTools?: string[],
 *   onSpawned?: (info: { pid: number }) => void,
 *   onMeta?: (meta: { effectiveModel: string }) => void,
 *   agentId?: string,
 * }} opts
 * @returns {Promise<{ exitCode: number, resultPath: string, processExited: true, timedOut: boolean, result: object }>}
 */
export async function runWorkerProcess({
  binding,
  cwd,
  promptText,
  workerRoot,
  timeoutMs,
  emit = () => {},
  eventBase = {},
  extraReadDirs = [],
  allowedTools,
  onSpawned,
  onMeta,
  agentId,
}) {
  const adapter = adapterFor(binding.runtime);
  const stdoutLog = path.join(workerRoot, 'stdout.log');
  const stderrLog = path.join(workerRoot, 'stderr.log');
  const resultPath = path.join(workerRoot, 'result.json');
  const promptPath = path.join(workerRoot, 'prompt.md');
  const lastMessagePath = path.join(workerRoot, 'last-message.txt');

  fs.mkdirSync(workerRoot, { recursive: true });
  fs.writeFileSync(promptPath, promptText, 'utf8');
  fs.writeFileSync(stdoutLog, '');
  fs.writeFileSync(stderrLog, '');
  fs.rmSync(lastMessagePath, { force: true });

  const argvOpts = {
    model: binding.model,
    permissionProfile: binding.permissionProfile,
    repoRoot: cwd,
    effort: binding.effort,
    extraReadDirs,
    lastMessagePath,
  };
  if (allowedTools) argvOpts.allowedTools = allowedTools;
  const argv = adapter.argv(argvOpts);

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: {
      ...workerEnv(binding.runtime),
      ...(agentId ? { ZEDPSTACK_AGENT_ID: agentId } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const spawnError = new Promise((_, reject) => child.once('error', reject));
  spawnError.catch(() => {});

  emit('worker.spawned', {
    ...eventBase,
    runtime: binding.runtime,
    model: binding.model,
    permissionProfile: binding.permissionProfile,
    pid: child.pid,
    cwd,
    argv,
    promptDelivery: 'stdin',
    promptBytes: Buffer.byteLength(promptText, 'utf8'),
  });
  if (child.pid) onSpawned?.({ pid: child.pid });

  child.stdin.on('error', () => {});
  child.stdin.end(promptText);

  let aggregatedText = '';
  let terminalResultText = null;
  let lineBuf = '';
  const signals = { readAttempts: 0, readSuccess: 0, readDenied: 0 };
  let timedOut = false;
  let effectiveModel = null;
  const activity = createActivityParser(binding.runtime, {
    onActivity: (text) => emit('worker.activity', { ...eventBase, runtime: binding.runtime, text }),
    onMeta: (m) => {
      effectiveModel = m.effectiveModel;
      emit('worker.meta', { ...eventBase, runtime: binding.runtime, model: binding.model, effectiveModel });
      onMeta?.(m);
    },
  });

  const consumeLine = (line) => {
    if (!line.trim()) return;
    activity.stdoutLine(line);
    accumulateStreamSignals(line, signals);
    const { chunk, terminalResult } = extractStreamText(line);
    if (terminalResult !== null) terminalResultText = terminalResult;
    if (chunk) aggregatedText += chunk;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    emit('worker.timeout', { ...eventBase, pid: child.pid, timeoutMs });
    kill(child, 'SIGTERM');
    setTimeout(() => kill(child, 'SIGKILL'), 5000).unref();
  }, timeoutMs);

  const exitCode = await Promise.race([
    spawnError,
    new Promise((resolve) => {
      child.stdout.on('data', (buf) => {
        const chunk = buf.toString();
        fs.appendFileSync(stdoutLog, chunk);
        emit('worker.output', { ...eventBase, runtime: binding.runtime, stream: 'stdout', chunk });
        if (!adapter.streamJson) return;
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        lines.forEach(consumeLine);
      });
      child.stderr.on('data', (buf) => {
        const chunk = buf.toString();
        fs.appendFileSync(stderrLog, chunk);
        activity.stderrChunk(chunk);
        emit('worker.stderr', { ...eventBase, runtime: binding.runtime, stream: 'stderr', chunk });
      });
      child.on('close', (code) => resolve(code ?? 1));
    }),
  ]).finally(() => clearTimeout(timer));

  if (adapter.streamJson && lineBuf.trim()) consumeLine(lineBuf);

  let text;
  let resultSignals = signals;
  if (adapter.streamJson) {
    text = (terminalResultText ?? aggregatedText).trim();
  } else {
    text = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, 'utf8').trim() : '';
    if (!text) text = fs.readFileSync(stdoutLog, 'utf8').trim();
    const stderrText = fs.readFileSync(stderrLog, 'utf8');
    const shellInvoked = detectCodexShellInvocation(stderrText);
    resultSignals = {
      shellInvoked,
      shellMutationInvoked: shellInvoked ? detectCodexShellMutation(stderrText) : false,
      ...accumulateCodexReadSignals(stderrText),
    };
  }

  const ok = exitCode === 0 && !timedOut && text.length > 0;
  const result = {
    ok,
    text: text || '(empty)',
    format: 'markdown',
    exitCode,
    timedOut,
    runtime: binding.runtime,
    model: binding.model,
    effectiveModel,
    permissionProfile: binding.permissionProfile,
    cliVersion: null,
    nativeSessionId: null,
    signals: resultSignals,
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

  if (ok) {
    emit('worker.completed', { ...eventBase, runtime: binding.runtime, exitCode, signals: resultSignals });
  } else {
    emit('worker.failed', {
      ...eventBase,
      runtime: binding.runtime,
      exitCode,
      reason: timedOut ? 'timeout' : exitCode !== 0 ? 'nonzero_exit' : 'empty_output',
    });
  }

  return { exitCode, resultPath, processExited: true, timedOut, result };
}
