# Brief: zedpstack ACP orchestrator (design task, read-only)

Repo: <repo> (Node >=20 ESM, zero dependencies, branch main). Today is 2026-10-17.

## What exists (read these first)
- Core, frontend-agnostic: src/agents/lifecycle.mjs (spawnAgent, waitAgents, agentStatus, agentResult, applyAgentChanges, closeAgent, listAgents, agentBoard), src/agents/store.mjs (agent.json per agent under <repo>/.zedpstack/agents/<id>/, RMW without lock), src/runtimes/worker.mjs, src/progressLog.mjs.
- MCP adapter: src/mcp/server.mjs, src/mcp/tools.mjs (spawn_agent, wait_agent, ... plus read_skill, list_models, setup_*). Used today by Claude/Codex/Cursor as orchestrators.
- ACP spike (works in Zed 1.24.2, verified by the user): src/acp/server.mjs, commands.mjs, follow.mjs, updates.mjs, docs/ACP_SPIKE.md. It has NO orchestrator: it only parses `/spawn <role> :: <prompt>` and `/board`, then shows one tool-call card per worker (kind 'other', cumulative text content replaced on each tool_call_update, throttled 250 ms).
- Worker model sheet and routing: src/workerModels.mjs, src/modelRouting.mjs, src/modelSheet.mjs, src/roles.mjs, src/permissions.mjs. Worker CLIs: `claude -p`, `codex exec`, Cursor `agent -p`.
- docs/ARCHITECTURE.md, docs/ACP_SPIKE.md, references/zedpstack-tools.md, SKILL.md (the orchestrator skill: poteto-mode orchestrator that never edits files itself and dispatches everything through spawn_agent).

## Facts verified about Zed 1.24.2 (do not re-litigate, use them)
- ACP v1 stable. Zed advertises terminal capability, _meta.terminal_output extension, forwards enabled `context_servers` as `mcpServers` in session/new, supports multiple independent threads.
- kind 'execute' cards without a registered terminal are NOT expandable; kind 'other' cards are expandable and render markdown; tool_call_update.content replaces the whole content list.
- Zed treats messages starting with `/` as slash commands and rejects ones not advertised via available_commands_update (send it AFTER the session/new response).
- ACP v1 has session config options (`configOptions` in session/new response, `session/set_config_option`, `config_option_update`) and modes (`modes`, `session/set_mode`, `current_mode_update`); Zed renders them as the dropdowns in the thread footer (the user's screenshot shows 'Bypass permissions', 'Default (recommended)', 'Default'). Verify the exact v1 schema from https://agentclientprotocol.com and github.com/agentclientprotocol/agent-client-protocol before relying on it.
- The extension API has no custom panels; ACP is the visual target. Standard ACP subagents are unstable/unsupported in Zed.
- Known risks: agent.json read-modify-write has no lock; Zed reuses one agent process across threads; MCP progress tokens are not sent by Zed.

## Product goal (from the user)
Zed -> "zedpstack" ACP agent becomes the ORCHESTRATOR UI and the single place to work:
1. The user opens a zedpstack thread and can type `/claude` (also `/codex`, `/cursor`). That selects the orchestrator runtime; the agent then reads the models available for that runtime and exposes them as Zed dropdowns (config options: model, effort, permission mode as applicable) the user changes with the footer controls, to configure the orchestrator to taste.
2. Then the user converses with the orchestrator. The orchestrator is a real LLM session running poteto-mode (skill /zedpstack): its assistant text streams into the thread as agent_message_chunk; when it calls spawn_agent / wait_agent etc., the corresponding workers appear live as expandable cards (the current spike's cards), whoever spawned them.
3. All the zedpstack flow (playbooks, roles, worker sheet, writer worktrees, review, apply_agent_changes) runs through this ACP agent. MCP stays supported unchanged for Claude/Codex/Cursor hosts.
4. Hardening: the design must address crash/cancel/cleanup (orphan processes, session/cancel, Zed reusing the process), agent.json races between frontends, multi-session, permission requests (session/request_permission) for risky orchestrator actions, version/model-resolution checks (see PROBLEMAS_ACTUALES.md: alias `opus` silently resolved to an older model; the effective model must be compared with the requested one), and testability without real CLIs (tests/fixtures/bin fake CLIs).

## Design questions to answer
A. How does the ACP agent host an orchestrator session? Candidates to weigh (give whole-shape alternatives, not variants): (1) spawn the runtime CLI headless per turn (`claude -p --output-format stream-json --resume`, `codex exec` / its resume, Cursor `agent -p`) with the zedpstack MCP server attached, parse its stream into ACP updates; (2) run an existing ACP agent (e.g. claude-agent-acp / codex-acp from the ACP registry) as a CHILD and proxy ACP<->ACP, injecting zedpstack's MCP server and overlaying worker cards; (3) another shape you find. For each: how conversation continuity works, how tool calls and permission prompts surface, how model/effort/mode dropdowns map, failure modes, and how much of the CLI's own UI richness (tool cards, diffs, thinking) is preserved.
B. Where is the seam between core and frontends? Name the module map: what moves to a `src/core` facade (if anything; prefer not to rewrite), what the MCP adapter and ACP adapter each own, and how worker activity reaches the ACP thread when the orchestrator (a child process using the MCP server) spawned the worker, not the ACP process (single source of truth: the agent store; a watcher that discovers new agents for the repo and attaches followAgent).
C. Config options model: data shape for runtime/model/effort/mode options, where model lists come from per runtime (static sheet vs CLI query such as `agent --list-models`, claude/codex model lists), how `/claude` is parsed and reflected via config_option_update, persistence of last choices (e.g. ~/.zedpstack), and validating requested vs effective model.
D. Concurrency and hardening plan: lock strategy for agent.json (per-agent, cross-process; prefer separate-before-serialize), process supervision and cancellation semantics, session lifecycle in a process reused across threads.
E. Smallest vertical slices in order (each ending in a verifiable check, usable in Zed), with the first slice being: `/claude` + model dropdowns + a plain conversation turn streaming assistant text.

## Deliverable
A design package per the architect runner prompt and rationale template (usage first, shape, tradeoffs, alternatives, open questions, next step), as your final text answer (do not write files). Include signatures/type sketches in JS (JSDoc typedefs), a module map, a sequence diagram for one orchestrated turn that spawns workers, and an ordered list of slices. Be decisive; commit to one recommended shape and name what you reject. Do not edit any file.
