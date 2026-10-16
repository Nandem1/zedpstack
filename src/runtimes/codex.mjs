import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildCodexArgv, workerEnv } from '../permissions.mjs';
import { detectCodexShellInvocation } from '../shellSignals.mjs';
import { appendChunk } from './stream.mjs';

export async function runCodexWorker({
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
  const codexLastMessage = path.join(workerRoot, 'codex-last-message.txt');
  const resultPath = path.join(workerRoot, 'result.json');
  const promptPath = path.join(workerRoot, 'prompt.md');

  fs.mkdirSync(workerRoot, { recursive: true });
  fs.writeFileSync(promptPath, promptText, 'utf8');
  fs.writeFileSync(stdoutLog, '');
  fs.writeFileSync(stderrLog, '');

  const argv = [
    ...buildCodexArgv({
      model: binding.model,
      repoRoot,
      permissionProfile: binding.permissionProfile,
      resultOutPath: codexLastMessage,
    }),
    promptText,
  ];

  const child = spawn(argv[0], argv.slice(1), {
    cwd: repoRoot,
    env: workerEnv('codex'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  eventSink.emit('worker.spawned', {
    runId,
    stepId,
    workerId,
    runtime: 'codex',
    model: binding.model,
    pid: child.pid,
    cwd: repoRoot,
    argv,
  });
  onWorkerSpawned?.({ pid: child.pid });

  const timeout = setTimeout(() => {
    eventSink.emit('worker.timeout', { runId, stepId, workerId, pid: child.pid });
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
  }, taskSpec.timeout);

  const exitCode = await new Promise((resolve, reject) => {
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

  let text = '';
  if (fs.existsSync(codexLastMessage)) {
    text = fs.readFileSync(codexLastMessage, 'utf8').trim();
  }
  if (!text && fs.existsSync(stdoutLog)) {
    text = fs.readFileSync(stdoutLog, 'utf8').trim();
  }

  const stderrText = fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, 'utf8') : '';
  const shellInvoked = detectCodexShellInvocation(stderrText);

  const result = {
    ok: exitCode === 0 && text.length >= 32,
    text: text || '(empty)',
    format: 'markdown',
    exitCode,
    runtime: 'codex',
    model: binding.model,
    cliVersion: null,
    nativeSessionId: null,
    signals: { shellInvoked },
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

  if (exitCode === 0 && result.ok) {
    eventSink.emit('worker.completed', { runId, stepId, workerId, exitCode });
  } else {
    eventSink.emit('worker.failed', {
      runId,
      stepId,
      workerId,
      exitCode,
      reason: 'exit_or_empty',
    });
  }

  return { exitCode, resultPath, processExited: true };
}
