import {
  assertPermissionProfile,
  verifyRuntimeAvailable,
} from '../permissions.mjs';
import { runWorkerProcess } from './worker.mjs';

/** Playbook-step entry point: resolves the CLI, then runs the shared worker. */
export async function runWorkerForBinding(ctx) {
  const { binding } = ctx;
  assertPermissionProfile(binding);
  if (!ctx.repoRoot) {
    throw new Error(`${binding.runtime} worker requires repoRoot`);
  }
  const cliVersion = verifyRuntimeAvailable(binding);

  const outcome = await runWorkerProcess({
    binding,
    cwd: ctx.repoRoot,
    promptText: ctx.promptText,
    workerRoot: ctx.workerRoot,
    timeoutMs: ctx.taskSpec.timeout,
    emit: (type, payload) => ctx.eventSink.emit(type, payload),
    eventBase: {
      runId: ctx.runId,
      stepId: ctx.stepId,
      workerId: ctx.workerId,
      role: ctx.role,
    },
    onSpawned: ctx.onWorkerSpawned,
  });

  return { ...outcome, cliVersion };
}
