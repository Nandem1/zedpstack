/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Tools: the portable Agent replacement. Prompts: `/zedpstack` entry point.
 */

import readline from 'node:readline';
import { ZEDPSTACK_VERSION } from '../constants.mjs';
import { TOOLS, readOwnDoc } from './tools.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INSTRUCTIONS = [
  'zedpstack runs pstack (poteto-mode) on any host by replacing the Agent/Task tool with CLI workers.',
  'When a pstack skill says to dispatch an Agent, call spawn_agent with the same prompt, subagent_type, model and readonly fields (or role + slot to use the worker sheet), then wait_agent.',
  'Spawn independent agents in one turn for fan-out. Review each writer diff (agent_result) before apply_agent_changes.',
  'Read the full mapping with read_skill {skill: "zedpstack", file: "references/zedpstack-tools.md"}.',
].join(' ');

const PROMPTS = [
  {
    name: 'zedpstack',
    title: 'zedpstack (poteto-mode orchestrator)',
    description: 'Orchestrate a task with poteto-mode, dispatching subagents through zedpstack CLI workers.',
    arguments: [{ name: 'task', description: 'What you want done', required: true }],
  },
];

/** The `/zedpstack` prompt is SKILL.md's body, so the skill and the prompt never drift. */
export function orchestratorPrompt(task) {
  const { text, path: skillPath } = readOwnDoc('SKILL.md');
  const body = text.replace(/^---[\s\S]*?---\s*/, '').trim();
  return `${body}\n\n(zedpstack lives at ${skillPath.replace(/\/SKILL\.md$/, '')}.)\n\n## Task\n\n${task ?? ''}\n`;
}

const err = (code, message) => ({ code, message });

export async function handleRequest(msg, { notify = () => {} } = {}) {
  const { method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'zedpstack', version: ZEDPSTACK_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { rpc: -32602 });
      const args = params.arguments ?? {};
      const progressToken = params._meta?.progressToken;
      const ctx = {
        progress:
          progressToken === undefined
            ? null
            : ({ progress, total, message }) =>
                notify('notifications/progress', { progressToken, progress, total, message }),
      };
      try {
        const result = await tool.handler(args, ctx);
        const content = [];
        if (tool.board) {
          try {
            const board = tool.board(args, result);
            if (board) content.push({ type: 'text', text: board });
          } catch {
            // the board is a view; never fail the call over it
          }
        }
        content.push({ type: 'text', text: JSON.stringify(result, null, 2) });
        return { content, isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: `zedpstack ${params.name} failed: ${e.message}` }], isError: true };
      }
    }
    case 'prompts/list':
      return { prompts: PROMPTS };
    case 'prompts/get': {
      if (params.name !== 'zedpstack') {
        throw Object.assign(new Error(`Unknown prompt: ${params.name}`), { rpc: -32602 });
      }
      return {
        description: PROMPTS[0].description,
        messages: [{ role: 'user', content: { type: 'text', text: orchestratorPrompt(params.arguments?.task) } }],
      };
    }
    case 'resources/list':
      return { resources: [] };
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
  }
}

export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: err(-32700, 'Parse error') });
      return;
    }
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (!isRequest) return;
    try {
      const result = await handleRequest(msg, {
        notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
      });
      write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: err(e.rpc ?? -32603, e.message) });
    }
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
