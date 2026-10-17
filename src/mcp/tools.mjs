import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatBoardText } from '../agents/board.mjs';
import {
  agentBoard,
  agentResult,
  agentStatus,
  applyAgentChanges,
  closeAgent,
  listAgents,
  spawnAgent,
  waitAgents,
} from '../agents/lifecycle.mjs';
import { RUNTIME_BINARIES } from '../permissions.mjs';
import { listPstackSkills, readPstackSkillFile, resolvePstackInstall } from '../pstack.mjs';
import { describeWorkerModels } from '../workerModels.mjs';
import { zedpstackRoot } from '../paths.mjs';

const repoProp = {
  type: 'string',
  description: 'Absolute path of the repository the agent works on. Defaults to the MCP server cwd; pass it explicitly.',
};
const agentIdProp = { type: 'string', description: 'Id returned by spawn_agent.' };

function defaultRepo(args) {
  return args.repo ?? process.env.ZEDPSTACK_REPO ?? process.cwd();
}

function runtimeAvailability() {
  const out = {};
  for (const [runtime, bin] of Object.entries(RUNTIME_BINARIES)) {
    const res = spawnSync(bin, [runtime === 'cursor' ? '-v' : '--version'], { encoding: 'utf8' });
    out[runtime] = res.status === 0 ? (res.stdout || res.stderr).trim().split('\n')[0] : null;
  }
  return out;
}

export const TOOLS = [
  {
    name: 'spawn_agent',
    description:
      'Start a pstack subagent in the background on a CLI worker (claude -p, codex exec, or Cursor agent -p) and return its agent_id at once. ' +
      "Use it wherever a pstack skill says to dispatch the Agent/Task tool: copy the skill's prompt, subagent_type, model and readonly fields. " +
      'Leave model unset and pass role (the pstack-models.md role line, e.g. "how explorer", "architect runners" with slot) to use the zedpstack worker sheet. ' +
      'Writers (readonly false) get their own git worktree and branch by default. Spawn several in one turn for parallel fan-out, then wait_agent.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full task for the subagent. Pass file pointers, not inlined context.' },
        description: { type: 'string', description: 'Short label (3-6 words).' },
        subagent_type: {
          type: 'string',
          description: 'pstack subagent type: "general-purpose" (default), "poteto-agent" / "pstack:poteto-agent" (reads poteto-mode first), "comment-sicko". An effort suffix like "pstack:poteto-agent-high" sets effort.',
        },
        role: { type: 'string', description: 'pstack-models.md role line used to pick the model, e.g. "how explorer", "interrogate reviewers".' },
        slot: { type: 'integer', minimum: 0, description: 'Index into a panel role (architect runners, interrogate reviewers, arena runners). Default 0.' },
        model: { type: 'string', description: 'Explicit worker model slug; overrides role. Prefix with "claude:", "codex:" or "cursor:" to force the CLI.' },
        runtime: { type: 'string', enum: ['claude', 'codex', 'cursor'], description: 'Force the worker CLI. Usually inferred from the model.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        readonly: { type: 'boolean', description: 'true for explorers, reviewers and synthesizers. Default false (may edit files), like the Agent tool.' },
        isolation: { type: 'string', enum: ['worktree', 'none'], description: 'Writers default to "worktree". "none" edits the repo in place; use it for a single writer only.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'pstack skills the worker reads in full before starting, e.g. ["architect"].' },
        base: { type: 'string', description: 'Git ref the worktree starts from. Default HEAD.' },
        timeout_seconds: { type: 'integer', minimum: 30, description: 'Hard limit for the worker. Default 1800.' },
        repo: repoProp,
      },
      required: ['prompt'],
    },
    handler: (args) => spawnAgent({ ...args, repo: defaultRepo(args) }),
    board: (args) => formatBoardText(agentBoard({ repo: defaultRepo(args), recentMinutes: 0 })),
  },
  {
    name: 'wait_agent',
    description:
      'Wait for agents to finish and return their final reports. mode "all" (default) waits for every id, "any" returns when the first finishes. ' +
      'Returns early on timeout with the still-running agents listed under pending; call again to keep waiting. Keep timeout_seconds under your host tool timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_ids: { type: 'array', items: { type: 'string' }, description: 'Ids to wait for. Empty means every unfinished agent in the repo.' },
        mode: { type: 'string', enum: ['all', 'any'] },
        timeout_seconds: { type: 'integer', minimum: 0, maximum: 3600, description: 'Default 50.' },
        repo: repoProp,
      },
    },
    handler: (args, ctx) => {
      let lastMessage = null;
      let lastSent = 0;
      return waitAgents({
        repo: defaultRepo(args),
        ids: args.agent_ids,
        mode: args.mode,
        timeoutSeconds: args.timeout_seconds ?? 50,
        onTick: ({ rows, done, total }) => {
          const message = formatBoardText(rows);
          if (message === lastMessage && Date.now() - lastSent < 10_000) return;
          lastMessage = message;
          lastSent = Date.now();
          ctx.progress?.({ progress: done, total, message });
        },
      });
    },
    board: (args, data) =>
      formatBoardText(
        agentBoard({ repo: defaultRepo(args), ids: [...data.done, ...data.pending].map((a) => a.agent_id) }),
      ),
  },
  {
    name: 'agent_status',
    description: 'Status of one agent plus its latest progress lines (files read, commands run).',
    inputSchema: { type: 'object', properties: { agent_id: agentIdProp, repo: repoProp }, required: ['agent_id'] },
    handler: (args) => agentStatus({ repo: defaultRepo(args), id: args.agent_id }),
    board: (args) => formatBoardText(agentBoard({ repo: defaultRepo(args), ids: [args.agent_id] }), { header: false }),
  },
  {
    name: 'agent_result',
    description: "An agent's final report, and for writers the commit, branch and changed files. Review the diff yourself before trusting it.",
    inputSchema: { type: 'object', properties: { agent_id: agentIdProp, repo: repoProp }, required: ['agent_id'] },
    handler: (args) => agentResult({ repo: defaultRepo(args), id: args.agent_id }),
  },
  {
    name: 'apply_agent_changes',
    description: "Bring a finished writer's commit into the host working tree as uncommitted changes (git cherry-pick --no-commit). Aborts cleanly on conflict.",
    inputSchema: { type: 'object', properties: { agent_id: agentIdProp, repo: repoProp }, required: ['agent_id'] },
    handler: (args) => applyAgentChanges({ repo: defaultRepo(args), id: args.agent_id }),
  },
  {
    name: 'close_agent',
    description: 'Stop an agent if it is still running. Optionally remove its worktree (and branch). Use it to abandon an agent before re-dispatching fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: agentIdProp,
        remove_worktree: { type: 'boolean' },
        delete_branch: { type: 'boolean' },
        repo: repoProp,
      },
      required: ['agent_id'],
    },
    handler: (args) =>
      closeAgent({
        repo: defaultRepo(args),
        id: args.agent_id,
        removeWorktree: Boolean(args.remove_worktree),
        deleteBranch: Boolean(args.delete_branch),
      }),
  },
  {
    name: 'list_agents',
    description: 'Agents spawned in this repo, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['starting', 'running', 'completed', 'failed', 'stopped'] },
        repo: repoProp,
      },
    },
    handler: (args) => listAgents({ repo: defaultRepo(args), status: args.status }),
    board: (args, data) => formatBoardText(agentBoard({ repo: defaultRepo(args), ids: data.map((a) => a.agent_id) })),
  },
  {
    name: 'list_models',
    description:
      'The zedpstack worker sheet: each pstack role line with the runtime and model its slots spawn, and which worker CLIs are installed. ' +
      "Read it instead of your host's pstack-models.md when choosing spawn_agent roles; panel length sets the fan-out count.",
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ ...describeWorkerModels(), runtimes: runtimeAvailability() }),
  },
  {
    name: 'read_skill',
    description:
      'Read a pstack skill file (default SKILL.md), e.g. skill "poteto-mode" file "playbooks/bug-fix.md". With no skill, lists installed skills. ' +
      'skill "zedpstack" reads this package\'s own docs (file "references/zedpstack-tools.md").',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        file: { type: 'string', description: 'Path inside the skill directory. Default SKILL.md.' },
      },
    },
    handler: (args) => {
      if (!args.skill) {
        const install = resolvePstackInstall();
        return { pstackRoot: install.root, version: install.version, skills: listPstackSkills() };
      }
      if (args.skill === 'zedpstack') return readOwnDoc(args.file ?? 'SKILL.md');
      return readPstackSkillFile(args.skill, args.file ?? 'SKILL.md');
    },
  },
];

const OWN_DOCS = new Set(['SKILL.md', 'references/zedpstack-tools.md', 'setup-zedpstack/SKILL.md']);

export function readOwnDoc(file) {
  if (!OWN_DOCS.has(file)) {
    throw new Error(`zedpstack docs: ${[...OWN_DOCS].join(', ')}`);
  }
  const filePath = path.join(zedpstackRoot(), file);
  return { path: filePath, text: fs.readFileSync(filePath, 'utf8') };
}
