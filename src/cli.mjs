import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatBoardText } from './agents/board.mjs';
import { runTop } from './agents/top.mjs';
import {
  agentBoard,
  agentResult,
  agentStatus,
  applyAgentChanges,
  closeAgent,
  execAgent,
  listAgents,
  spawnAgent,
  waitAgents,
} from './agents/lifecycle.mjs';
import { cancelRun } from './cancel.mjs';
import { HOSTS, runInstall } from './install.mjs';
import { startMcpServer } from './mcp/server.mjs';
import { dispatchScriptPath, runDir, zedpstackRoot } from './paths.mjs';
import { listPstackSkills, readPstackSkillFile, resolvePstackInstall } from './pstack.mjs';
import { completeJudgment, runPlaybook } from './run.mjs';
import { applyModelSheetToConfig, initModelSheet, showSetupStatus } from './setupConfig.mjs';
import { buildSetupPlan, writeSetup } from './setupWizard.mjs';
import { allowEdits, endSession } from './guard.mjs';
import { buildDoctorReport, formatDoctorReport } from './setupReport.mjs';
import { followProgress, tailProgressOnce } from './tailProgress.mjs';
import { watchRun } from './watchRun.mjs';
import { describeWorkerModels } from './workerModels.mjs';

const BOOLEAN_FLAGS = new Set([
  'tee-events',
  'dry-run',
  'strict',
  'human',
  'detach',
  'once',
  'persist-stream-events',
  'from-start',
  'no-follow',
  'readonly',
  'apply',
  'remove-worktree',
  'delete-branch',
  'any',
  'help',
  'refresh',
  'force',
]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const opts = { _: [] };
  while (args.length) {
    const a = args.shift();
    if (a === '--') {
      opts._.push(...args.splice(0));
      break;
    }
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) {
      opts[key] = a.slice(eq + 1);
    } else if (BOOLEAN_FLAGS.has(key) || args.length === 0) {
      opts[key] = true;
    } else {
      opts[key] = args.shift();
    }
  }
  return { command, opts };
}

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function readPromptArg(opts) {
  if (opts['prompt-file']) {
    const file = opts['prompt-file'];
    return fs.readFileSync(file === '-' ? 0 : path.resolve(file), 'utf8');
  }
  if (opts.prompt) return opts.prompt;
  if (opts._.length) return opts._.join(' ');
  throw new Error('agent spawn requires --prompt "...", --prompt-file <path>, or --prompt-file - (stdin)');
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function agentCommand(sub, opts, repoRoot) {
  const id = opts.id ?? opts['agent-id'];
  switch (sub) {
    case 'spawn':
      return spawnAgent({
        repo: repoRoot,
        prompt: readPromptArg(opts),
        description: opts.description,
        subagent_type: opts['subagent-type'],
        role: opts.role,
        slot: opts.slot !== undefined ? Number(opts.slot) : undefined,
        model: opts.model,
        runtime: opts.runtime,
        effort: opts.effort,
        readonly: Boolean(opts.readonly),
        isolation: opts.isolation,
        skills: list(opts.skills),
        base: opts.base,
        timeout_seconds: opts.timeout ? Number(opts.timeout) : undefined,
      }, { frontend: 'cli' });
    case 'exec':
      return execAgent({ repo: repoRoot, id });
    case 'status':
      return agentStatus({ repo: repoRoot, id, tail: Number(opts.tail ?? 8) });
    case 'wait':
      return waitAgents({
        repo: repoRoot,
        ids: list(opts.ids ?? id) ?? opts._,
        mode: opts.any ? 'any' : 'all',
        timeoutSeconds: Number(opts.timeout ?? 600),
      });
    case 'result':
      return agentResult({ repo: repoRoot, id });
    case 'apply':
      return applyAgentChanges({ repo: repoRoot, id });
    case 'close':
    case 'stop':
      return closeAgent({
        repo: repoRoot,
        id,
        removeWorktree: Boolean(opts['remove-worktree']),
        deleteBranch: Boolean(opts['delete-branch']),
      });
    case 'list':
      return listAgents({ repo: repoRoot, status: opts.status });
    case 'board':
      return formatBoardText(agentBoard({ repo: repoRoot, ids: list(opts.ids ?? id), recentMinutes: Number(opts.recent ?? 30) }));
    default:
      throw new Error('agent subcommands: spawn | status | wait | result | apply | close | list | board');
  }
}

function detachRun(opts, repoRoot, goal, playbook) {
  const runId = opts['run-id'] ?? randomUUID();
  const runRoot = runDir(repoRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const childArgs = [dispatchScriptPath(), 'run', '--run-id', runId, '--goal', goal, '--repo', repoRoot, '--playbook', playbook];
  if (opts['context-file']) childArgs.push('--context-file', path.resolve(opts['context-file']));
  if (opts['persist-stream-events']) childArgs.push('--persist-stream-events');
  const logPath = path.join(runRoot, 'detach.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', log, log], cwd: repoRoot });
  child.unref();
  fs.closeSync(log);
  return {
    detached: true,
    runId,
    pid: child.pid,
    progressLog: path.join(runRoot, 'progress.log'),
    detachLog: logPath,
    follow: `node ${dispatchScriptPath()} follow --run-id ${runId} --repo ${repoRoot}`,
  };
}

const USAGE = `zedpstack — pstack subagents on any host (Claude Code, Codex, Cursor, Zed ACP)

Orchestrator plumbing:
  mcp                         start the MCP server (stdio)
  install [--host h,..] [--apply]   register MCP + skill (hosts: ${HOSTS.join(', ')})
  doctor [--human]            check CLIs, pstack, worker sheet, host registration
  session end|allow-edits|block-edits   orchestrator edit-guard session marker
  models                      worker sheet: role -> runtime/model
  skill [name] [--file f]     read a pstack skill file

Subagents (same contract as the MCP tools):
  agent spawn --prompt "..." [--role "how explorer"] [--slot n] [--model m] [--readonly]
              [--subagent-type poteto-agent] [--skills a,b] [--isolation worktree|none]
  agent wait [--ids a,b] [--any] [--timeout s] | status --id | result --id
  agent apply --id | close --id [--remove-worktree] | list | board
  top [--recent minutes] [--once]   live board of this repo's agents (run it in a terminal pane)

Batch playbooks (no orchestrator):
  run --playbook <id> --goal "..." [--detach] [--tee-events] | resume | judgment | cancel
  follow | watch | list | setup plan|write|show|init|apply

Common: --repo <path> (default cwd)`;

export async function main(argv) {
  const { command, opts } = parseArgs(argv);
  const repoRoot = path.resolve(opts.repo ?? process.cwd());

  if (!command || command === 'help' || opts.help) {
    print(USAGE);
    return;
  }

  if (command === 'mcp') {
    await startMcpServer();
    return;
  }

  if (command === 'agent') {
    const sub = opts._.shift();
    const result = await agentCommand(sub, opts, repoRoot);
    if (sub === 'exec') return;
    if (sub === 'spawn' || sub === 'wait') {
      const ids = sub === 'spawn' ? undefined : [...result.done, ...result.pending].map((a) => a.agent_id);
      result.board = formatBoardText(agentBoard({ repo: repoRoot, ids, recentMinutes: 0 }));
    }
    print(result);
    return;
  }

  if (command === 'top') {
    await runTop({ repoRoot, recentMinutes: Number(opts.recent ?? 30), once: Boolean(opts.once) });
    return;
  }

  if (command === 'models') {
    print(describeWorkerModels());
    return;
  }

  if (command === 'skill') {
    const name = opts._[0];
    if (!name) {
      const install = resolvePstackInstall();
      print({ pstackRoot: install.root, version: install.version, skills: listPstackSkills() });
      return;
    }
    process.stdout.write(readPstackSkillFile(name, opts.file ?? 'SKILL.md').text);
    return;
  }

  if (command === 'install') {
    print(runInstall({ hosts: list(opts.host) ?? HOSTS, apply: Boolean(opts.apply) }));
    return;
  }

  if (command === 'session') {
    const sub = opts._[0];
    if (sub === 'end') {
      endSession(repoRoot);
      print({ ended: true, repo: repoRoot });
      return;
    }
    if (sub === 'allow-edits') {
      print({ repo: repoRoot, editsAllowed: true, marker: allowEdits(repoRoot, true) });
      return;
    }
    if (sub === 'block-edits') {
      print({ repo: repoRoot, editsAllowed: false, marker: allowEdits(repoRoot, false) });
      return;
    }
    throw new Error('session subcommands: end | allow-edits | block-edits');
  }

  if (command === 'doctor' || (command === 'setup' && ['diagnose', 'doctor'].includes(opts._[0]))) {
    const report = buildDoctorReport();
    print(opts.human ? formatDoctorReport(report) : report);
    return;
  }

  if (command === 'run') {
    const playbook = opts.playbook ?? 'how-investigation';
    const goal = opts.goal ?? opts._[0];
    if (!goal) {
      throw new Error('run requires --goal "..."');
    }
    if (opts.detach) {
      print(detachRun(opts, repoRoot, goal, playbook));
      return;
    }
    const context = opts['context-file'] ? fs.readFileSync(path.resolve(opts['context-file']), 'utf8') : '';
    const result = await runPlaybook({
      playbookId: playbook,
      goal,
      repoRoot,
      runId: opts['run-id'],
      context,
      teeEvents: Boolean(opts['tee-events']),
      persistStreamEvents: Boolean(opts['persist-stream-events']),
    });
    print({ runId: result.runId, runRoot: result.runRoot, status: result.manifest.status });
    if (result.manifest.status === 'failed') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'resume') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('resume requires --run-id');
    const context = opts['context-file'] ? fs.readFileSync(path.resolve(opts['context-file']), 'utf8') : '';
    const result = await runPlaybook({
      playbookId: opts.playbook ?? 'how-investigation',
      goal: opts.goal ?? '',
      repoRoot,
      runId,
      context,
      teeEvents: Boolean(opts['tee-events']),
      persistStreamEvents: Boolean(opts['persist-stream-events']),
    });
    print({ runId: result.runId, status: result.manifest.status });
    if (result.manifest.status === 'failed') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'judgment') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('judgment requires --run-id');
    const manifest = completeJudgment({ repoRoot, runId });
    print({ runId, status: manifest.status });
    return;
  }

  if (command === 'cancel') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('cancel requires --run-id');
    const { manifest, alreadyTerminal } = cancelRun({ repoRoot, runId });
    print({ runId, status: manifest.status, alreadyTerminal });
    return;
  }

  if (command === 'follow' || command === 'tail-progress') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('follow requires --run-id');
    if (opts.once) {
      const { text, nextOffset, terminal } = tailProgressOnce({ repoRoot, runId, offset: Number(opts.offset ?? 0) });
      if (text) process.stdout.write(text);
      print({ nextOffset, terminal });
      return;
    }
    await followProgress({ repoRoot, runId, fromStart: Boolean(opts['from-start']) });
    return;
  }

  if (command === 'watch') {
    const runId = opts['run-id'];
    if (!runId) throw new Error('watch requires --run-id');
    await watchRun({ repoRoot, runId, fromStart: Boolean(opts['from-start']), follow: !opts['no-follow'] });
    return;
  }

  if (command === 'list') {
    const dir = path.join(zedpstackRoot(), 'playbooks');
    const ids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    print({ playbooks: ids });
    return;
  }

  if (command === 'setup') {
    const sub = opts._[0] ?? 'show';
    if (sub === 'show') {
      print(showSetupStatus());
      return;
    }
    if (sub === 'plan') {
      print(await buildSetupPlan({ refresh: Boolean(opts.refresh) }));
      return;
    }
    if (sub === 'write') {
      const raw = opts.answers;
      if (!raw) throw new Error('setup write requires --answers \'{"defaultEffort":"medium","roles":{"bug-fix":["gpt-6.1-sol"]}}\' (or @file.json)');
      const answers = JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw);
      print(await writeSetup({ ...answers, dryRun: Boolean(opts['dry-run']), force: Boolean(opts.force) }));
      return;
    }
    if (sub === 'init') {
      print({ modelSheet: initModelSheet(opts.file), created: true });
      return;
    }
    if (sub === 'apply') {
      print(
        applyModelSheetToConfig({
          sheetPath: opts.file ?? opts['model-sheet'],
          configPath: opts.config,
          dryRun: Boolean(opts['dry-run']),
          strict: Boolean(opts.strict),
        }),
      );
      return;
    }
    throw new Error('setup subcommands: plan | write | show | doctor | init | apply');
  }

  throw new Error(`Unknown command: ${command}. Run "dispatch help".`);
}
