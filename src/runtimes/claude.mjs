import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaudeArgv, workerEnv } from '../permissions.mjs';
import {
  accumulateClaudeSignals,
  appendChunk,
  extractClaudeStreamText,
} from './stream.mjs';

export async function runClaudeWorker({
  binding,
  taskSpec,
  workerRoot,
  repoRoot,
  promptText,
  eventSink,
  workerId,
  runId,
  stepId,
  onWorkerSpawned,
}) {
  const stdoutLog = path.join(workerRoot, 'stdout.log');
  const stderrLog = path.join(workerRoot, 'stderr.log');
  const resultPath = path.join(workerRoot, 'result.json');
  const promptPath = path.join(workerRoot, 'prompt.md');

  fs.mkdirSync(workerRoot, { recursive: true });
  fs.writeFileSync(promptPath, promptText, 'utf8');
  fs.writeFileSync(stdoutLog, '');
  fs.writeFileSync(stderrLog, '');

  const argv = buildClaudeArgv({
    model: binding.model,
    permissionProfile: binding.permissionProfile,
    repoRoot,
  });

  const child = spawn(argv[0], argv.slice(1), {
    cwd: repoRoot,
    env: workerEnv('claude'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  eventSink.emit('worker.spawned', {
    runId,
    stepId,
    workerId,
    runtime: 'claude',
    model: binding.model,
    pid: child.pid,
    cwd: repoRoot,
    argv,
  });
  onWorkerSpawned?.({ pid: child.pid });

  child.stdin.write(promptText);
  child.stdin.end();

  let aggregatedText = '';
  let terminalResultText = null;
  let lineBuf = '';
  const signals = { readAttempts: 0, readSuccess: 0, readDenied: 0 };

  const timeout = setTimeout(() => {
    eventSink.emit('worker.timeout', { runId, stepId, workerId, pid: child.pid });
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
  }, taskSpec.timeout);

  await new Promise((resolve, reject) => {
    child.stdout.on('data', (buf) => {
      const chunk = buf.toString();
      appendChunk(stdoutLog, chunk);
      eventSink.emit('worker.output', {
        runId,
        stepId,
        workerId,
        stream: 'stdout',
        chunk,
      });

      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        accumulateClaudeSignals(line, signals);
        const { chunk, terminalResult } = extractClaudeStreamText(line);
        if (terminalResult) terminalResultText = terminalResult;
        if (chunk) aggregatedText += chunk;
      }
    });

    child.stderr.on('data', (buf) => {
      const chunk = buf.toString();
      appendChunk(stderrLog, chunk);
      eventSink.emit('worker.stderr', {
        runId,
        stepId,
        workerId,
        stream: 'stderr',
        chunk,
      });
    });

    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });

  if (lineBuf.trim()) {
    accumulateClaudeSignals(lineBuf, signals);
    const { chunk, terminalResult } = extractClaudeStreamText(lineBuf);
    if (terminalResult) terminalResultText = terminalResult;
    if (chunk) aggregatedText += chunk;
  }

  const exitCode = child.exitCode ?? 1;
  const text = (terminalResultText ?? aggregatedText).trim();

  const result = {
    ok: exitCode === 0,
    text: text || '(empty)',
    format: 'markdown',
    exitCode,
    runtime: 'claude',
    model: binding.model,
    cliVersion: null,
    nativeSessionId: null,
    signals,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

  if (exitCode === 0) {
    eventSink.emit('worker.completed', { runId, stepId, workerId, exitCode, signals });
  } else {
    eventSink.emit('worker.failed', {
      runId,
      stepId,
      workerId,
      exitCode,
      reason: 'nonzero_exit',
    });
  }

  return { exitCode, resultPath, processExited: true };
}
