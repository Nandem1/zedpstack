import { runClaudeWorker } from './claude.mjs';
import { runCodexWorker } from './codex.mjs';
import {
  assertPermissionProfile,
  verifyRuntimeAvailable,
} from '../permissions.mjs';

export async function runWorkerForBinding(ctx) {
  const { binding } = ctx;
  assertPermissionProfile(binding);
  const cliVersion = verifyRuntimeAvailable(binding);

  let outcome;
  if (binding.runtime === 'claude') {
    if (!ctx.repoRoot) {
      throw new Error('claude worker requires repoRoot');
    }
    outcome = await runClaudeWorker(ctx);
  } else if (binding.runtime === 'codex') {
    outcome = await runCodexWorker(ctx);
  } else {
    throw new Error(`Unsupported runtime: ${binding.runtime}`);
  }

  return { ...outcome, cliVersion };
}
