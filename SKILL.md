---
name: zedpstack
description: Orchestrate a task in poteto-mode on any host (Claude Code, Codex, Cursor, Zed ACP), dispatching every pstack subagent to Claude/Codex/Cursor CLI workers through zedpstack. Use for /zedpstack <task>. Use /setup-zedpstack to choose worker models.
disable-model-invocation: true
---

# zedpstack orchestrator

You are the orchestrator. You work in **poteto-mode**, and zedpstack is your subagent mechanism: it replaces the `Agent`/`Task` tool with CLI workers (`claude -p`, `codex exec`, Cursor `agent -p`) chosen per pstack role by the user's worker sheet. You decide; zedpstack spawns, isolates, and reports.

## Start

1. Load poteto-mode and read it in full. With the zedpstack MCP server: `read_skill {"skill": "poteto-mode"}`. Without it: `node <zedpstack>/scripts/dispatch.mjs skill poteto-mode`. Open every leaf it points to (`playbooks/<name>.md`, `principle-*` skills, routed skills such as `how` or `architect`) the same way.
2. Read the tool mapping: `read_skill {"skill": "zedpstack", "file": "references/zedpstack-tools.md"}` (or `references/zedpstack-tools.md` next to this file). It is to zedpstack what poteto-mode's `references/codex-tools.md` is to Codex.
3. Classify the task against poteto-mode's Playbooks (Investigation, Bug fix, Feature, Refactoring, ...), open the matched playbook, copy its steps into your todolist verbatim, and run it.

## Rules

- Every subagent dispatch that poteto-mode or a routed skill (`how`, `why`, `architect`, `arena`, `interrogate`, `swarm`, `reflect`) prescribes goes through `spawn_agent`, even when your host has its own subagent tool. That is what lets the worker sheet put the explorer on haiku, the architect runners on Codex, and a reviewer on Cursor.
- Pass the skill's `role` line (and `slot` for panels) instead of a model, so the worker sheet decides. Call `list_models` once to see the roles and panel sizes.
- Fan out by issuing several `spawn_agent` calls in one turn, then one `wait_agent` with every id. Call `wait_agent` again while `pending` is not empty.
- You own every report. Read each one, check its claims against the code, and for writers review the commit (`agent_result` → `git show <commit>`) before `apply_agent_changes`.
- Judgment, synthesis, and every message to the user stay in this chat.

## When the MCP server is missing

The same operations exist as a CLI that prints JSON (`--repo` defaults to the cwd):

```bash
Z=<zedpstack>/scripts/dispatch.mjs
node $Z models
node $Z agent spawn --repo "$PWD" --role "how explorer" --readonly --description "map auth" --prompt-file /tmp/brief.md
node $Z agent wait --repo "$PWD" --ids <id1>,<id2> --timeout 600
node $Z agent result --id <id> | apply --id <id> | close --id <id> --remove-worktree
```

Register the server with `node $Z install --apply` and run `node $Z doctor --human` when something does not line up.
