import fs from 'node:fs';
import path from 'node:path';
import { cancelRun } from './cancel.mjs';
import { completeJudgment, runPlaybook } from './run.mjs';

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const opts = { _: [] };
  while (args.length) {
    const a = args[0];
    if (a === '--') {
      args.shift();
      opts._.push(...args);
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      args.shift();
      if (['goal', 'playbook', 'repo', 'run-id', 'file', 'context-file'].includes(key)) {
        opts[key] = args.shift();
      } else if (key === 'tee-events') {
        opts.teeEvents = true;
      } else if (key === 'persist-stream-events') {
        opts.persistStreamEvents = true;
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(args.shift());
    }
  }
  return { command, opts };
}

export async function main(argv) {
  const { command, opts } = parseArgs(argv);
  const repoRoot = path.resolve(opts.repo ?? process.cwd());

  if (command === 'run') {
    const playbook = opts.playbook ?? 'how-investigation';
    const goal = opts.goal ?? opts._[0];
    if (!goal) {
      throw new Error('run requires --goal "..."');
    }
    let context = '';
    const contextFile = opts['context-file'];
    if (contextFile) {
      context = fs.readFileSync(path.resolve(contextFile), 'utf8');
    }
    const result = await runPlaybook({
      playbookId: playbook,
      goal,
      repoRoot,
      context,
      teeEvents: Boolean(opts.teeEvents),
      persistStreamEvents: Boolean(opts.persistStreamEvents),
    });
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          runRoot: result.runRoot,
          status: result.manifest.status,
        },
        null,
        2,
      ),
    );
    if (result.manifest.status === 'failed') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'resume') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('resume requires --run-id');
    let context = '';
    if (opts['context-file']) {
      context = fs.readFileSync(path.resolve(opts['context-file']), 'utf8');
    }
    const result = await runPlaybook({
      playbookId: opts.playbook ?? 'how-investigation',
      goal: opts.goal ?? '',
      repoRoot,
      runId,
      context,
      teeEvents: Boolean(opts.teeEvents),
      persistStreamEvents: Boolean(opts.persistStreamEvents),
    });
    console.log(JSON.stringify({ runId: result.runId, status: result.manifest.status }, null, 2));
    return;
  }

  if (command === 'judgment') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('judgment requires --run-id');
    const manifest = completeJudgment({ repoRoot, runId });
    console.log(JSON.stringify({ runId, status: manifest.status }, null, 2));
    return;
  }

  if (command === 'cancel') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('cancel requires --run-id');
    const { manifest, alreadyTerminal } = cancelRun({ repoRoot, runId });
    console.log(
      JSON.stringify({ runId, status: manifest.status, alreadyTerminal }, null, 2),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}. Use: run | resume | judgment | cancel`);
}
