import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cancelRun } from './cancel.mjs';
import { completeJudgment, runPlaybook } from './run.mjs';
import {
  applyModelSheetToConfig,
  initModelSheet,
  showSetupStatus,
} from './setupConfig.mjs';
import { buildSetupDiagnosis, formatSetupDiagnosisHuman } from './setupReport.mjs';
import { watchRun } from './watchRun.mjs';
import { followProgress, tailProgressOnce } from './tailProgress.mjs';
import { spawn } from 'node:child_process';
import { dispatchScriptPath } from './paths.mjs';
import { zedpstackRoot } from './paths.mjs';

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
      if (
        [
          'goal',
          'playbook',
          'repo',
          'run-id',
          'file',
          'context-file',
          'model-sheet',
          'config',
          'offset',
        ].includes(key)
      ) {
        opts[key] = args.shift();
      } else if (key === 'tee-events') {
        opts.teeEvents = true;
      } else if (key === 'dry-run') {
        opts.dryRun = true;
      } else if (key === 'strict') {
        opts.strict = true;
      } else if (key === 'human') {
        opts.human = true;
      } else if (key === 'detach') {
        opts.detach = true;
      } else if (key === 'once') {
        opts.once = true;
      } else if (key === 'persist-stream-events') {
        opts.persistStreamEvents = true;
      } else if (key === 'from-start') {
        opts.fromStart = true;
      } else if (key === 'no-follow') {
        opts['no-follow'] = true;
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
    if (opts.detach) {
      const script = dispatchScriptPath();
      const runId = opts['run-id'] ?? randomUUID();
      const childArgs = [
        script,
        'run',
        '--run-id',
        runId,
        '--goal',
        goal,
        '--repo',
        repoRoot,
        '--playbook',
        playbook,
        '--tee-events',
      ];
      if (opts['context-file']) {
        childArgs.push('--context-file', path.resolve(opts['context-file']));
      }
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: repoRoot,
      });
      child.unref();
      console.log(
        JSON.stringify(
          {
            detached: true,
            runId,
            progressLog: runId
              ? path.join(repoRoot, '.zedpstack', 'runs', runId, 'progress.log')
              : null,
            follow:
              runId
                ? `node ${script} follow --run-id ${runId} --repo ${repoRoot}`
                : null,
          },
          null,
          2,
        ),
      );
      return;
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
      runId: opts['run-id'],
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

  if (command === 'follow' || command === 'tail-progress') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('follow requires --run-id');
    if (opts.once) {
      const { text, nextOffset, terminal } = tailProgressOnce({
        repoRoot,
        runId,
        offset: Number(opts.offset ?? 0),
      });
      if (text) process.stdout.write(text);
      console.log(
        JSON.stringify({ nextOffset, terminal }, null, 2),
      );
      return;
    }
    await followProgress({
      repoRoot,
      runId,
      fromStart: Boolean(opts.fromStart),
    });
    return;
  }

  if (command === 'watch') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('watch requires --run-id');
    await watchRun({
      repoRoot,
      runId,
      fromStart: Boolean(opts.fromStart),
      follow: !opts['no-follow'],
    });
    return;
  }

  if (command === 'list') {
    const dir = path.join(zedpstackRoot(), 'playbooks');
    const ids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    console.log(JSON.stringify({ playbooks: ids }, null, 2));
    return;
  }

  if (command === 'setup') {
    const sub = opts._[0] ?? 'show';
    if (sub === 'show') {
      console.log(JSON.stringify(showSetupStatus(), null, 2));
      return;
    }
    if (sub === 'diagnose' || sub === 'plan') {
      const report = buildSetupDiagnosis();
      if (opts.human) {
        console.log(formatSetupDiagnosisHuman(report));
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
      return;
    }
    if (sub === 'init') {
      const target = initModelSheet(opts.file);
      console.log(JSON.stringify({ modelSheet: target, created: true }, null, 2));
      return;
    }
    if (sub === 'apply') {
      const result = applyModelSheetToConfig({
        sheetPath: opts.file ?? opts['model-sheet'],
        configPath: opts.config,
        dryRun: Boolean(opts.dryRun),
        strict: Boolean(opts.strict),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error('setup subcommands: show | diagnose | plan | init | apply');
  }

  throw new Error(
    `Unknown command: ${command}. Use: run | resume | judgment | cancel | follow | watch | list | setup`,
  );
}
