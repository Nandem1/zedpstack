# zedpstack tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Agent` tool, `subagent_type`, Claude model names). Under zedpstack the skills are the same files; only subagent dispatch resolves differently. Read this when a pstack skill tells you to spawn, wait for, or stop a subagent. Every other action (read, edit, shell, search, todolist, asking the user) uses your host's own tools; on Codex, poteto-mode's `references/codex-tools.md` still maps those.

MCP tool names below are bare. Hosts prefix them, for example `mcp__zedpstack__spawn_agent` on Claude Code.

## Tool actions

| pstack / Claude action | zedpstack |
|------------------------|-----------|
| Dispatch a subagent (the `Agent`/`Task` tool) | `spawn_agent` |
| Dispatch N parallel subagents in one turn | N `spawn_agent` calls in one response, then one `wait_agent` with all ids |
| `run_in_background: true` | Implicit. `spawn_agent` always returns at once with an `agent_id` |
| Wait for a subagent result | `wait_agent`. It returns early on timeout; call it again while `pending` is not empty |
| Check on a running subagent | `agent_status` (latest files read and commands run) |
| Read a finished subagent's report | `wait_agent` returns it; `agent_result` re-reads it |
| Stop or abandon a subagent | `close_agent`. Confirm `status` is `stopped` before you re-dispatch |
| Resume or message an existing subagent | Not supported. Dispatch a fresh subagent with consolidated scope, which is poteto-mode's default anyway |
| A writer's diff lands in your checkout | `apply_agent_changes` after you review the commit |
| Read a skill or playbook file | `read_skill {"skill": "<id>", "file": "<path>"}`, or your host's native skill loading |
| See configured models and panel sizes | `list_models` |

## Dispatch fields

| `Agent` field in a pstack skill | `spawn_agent` argument |
|---------------------------------|------------------------|
| `prompt` | `prompt`. Pass file pointers, not inlined context |
| `description` | `description` |
| `subagent_type: "pstack:poteto-agent"` | `subagent_type: "poteto-agent"`. The worker reads poteto-mode's SKILL.md first |
| `subagent_type: "general-purpose"` or none | omit `subagent_type` |
| `subagent_type: "pstack:effort-<level>"` / `"pstack:poteto-agent-<level>"` | same string; zedpstack turns the suffix into `effort` |
| `subagent_type: "comment-sicko"` | `subagent_type: "comment-sicko"` |
| `model`: "the `<role>` line" | `role: "<role>"`, and `slot: i` for the i-th entry of a panel row. Leave `model` unset |
| `model`: a literal slug | `model`. Prefix `claude:`, `codex:` or `cursor:` to force the CLI |
| `readonly: true` | `readonly: true` |
| no `readonly` (may write) | omit it. The writer gets its own git worktree on branch `zedpstack/<id>` |
| "give each writer its own worktree" (swarm, orchestrate) | already the default for writers |
| "load the X skill first" | `skills: ["x"]` |

## Models

- Do not read your host's `pstack-models.md` to pick worker models. Its slugs belong to the host's own subagent tool (a Cursor `composer-*` slug does not run under `claude -p`). `list_models` returns the zedpstack worker sheet, `~/.zedpstack/pstack-models.md`, with the runtime each slot spawns on.
- A panel row's length is its fan-out count. `architect runners: gpt-6.1-sol, sonnet` means two runners: `slot: 0` on Codex, `slot: 1` on Claude.
- A role with no line falls back to the pstack default from `models.json` (`list_models` marks it `pstack-default`).
- `inherit-parent` and `auto` cannot be honored by a separate CLI. zedpstack runs the pstack default instead and says so in the agent's `notes`.
- A spawn that names an unknown role fails before anything runs and lists the known roles.

## Writers

- A writer starts from `HEAD` in its own worktree. Uncommitted changes in your checkout are not visible to it; commit them first, or use `isolation: "none"` for a single writer that must see them.
- zedpstack commits whatever the writer leaves behind. `agent_result` returns `changes.commit`, `changes.files`, and `changes.diffStat`. A failed writer's commit carries `changes.partial: true`; treat it as salvage, not a result.
- Review with `git -C <repo> show <commit>`, then `apply_agent_changes` cherry-picks it into your working tree, staged and uncommitted. A conflict aborts cleanly and returns the error.
- Parallel writers never share files on disk. Merge their commits one at a time and re-verify after each.
- `close_agent {"remove_worktree": true}` cleans up; add `delete_branch: true` once the commit is applied or abandoned.
- In a Zed thread run by the zedpstack ACP agent, the user approves `apply_agent_changes`, a writer with `isolation: "none"`, a `close_agent` that would discard unapplied work, and `setup_write`. A refusal returns the usual shape with `error: "rejected by user"` and a `reason`, and nothing happened. Tell the user it was rejected and why; do not retry it another way. Other hosts never ask.

## Permissions

| | Claude (`claude -p`) | Codex (`codex exec`) | Cursor (`agent -p`) |
|---|---|---|---|
| `readonly: true` | tools `Read,Grep,Glob` only | `-s read-only` | `--mode ask` |
| writer | `acceptEdits`, `Edit,Write,Bash` with a shell allowlist (`permissions.claudeWriteAllowedTools` in `zedpstack.config.json`) | `-s workspace-write` sandbox | `--force --sandbox enabled` |

Every worker also gets read access to the pstack skills directory so it can open the skills you name.

## Showing progress

- Each `spawn_agent`, `wait_agent`, `agent_status` and `list_agents` result has two text blocks: a board (one row per agent with title, model, CLI and latest activity), then the JSON. Copy the board into your chat as SKILL.md shows; that is the user's only view of the subagents inside the chat.
- The board's title is the spawn's `description`. Use `<Skill>: <angle>`.
- `model → effective` on a row means the CLI ran that model for the requested slug. Every agent in the JSON carries `model_check` with `state`: `ok` (the CLI ran the expected model), `unverified` (no evidence yet, or an alias nobody probed; the row adds `(alias)`), or `mismatch` (the row adds `⚠ esperado <id>`).
- A `mismatch` worker stays `completed`, but `agent_result` and `wait_agent` add a `warnings` entry and start `text` with the same line. Do not attribute that verdict to the expected model: say which model gave it, or re-dispatch with the concrete id.
- `wait_agent` also sends MCP progress notifications carrying the board while it waits, when the host passes a `progressToken`. Hosts that render them show the board updating inside the tool call.
- `dispatch top` in a terminal pane draws the same board live, with spinners and elapsed time.

## Waiting and timeouts

`wait_agent` waits 50 seconds by default so it stays under host tool timeouts (Codex defaults to 60 s; `dispatch install` sets 600 s). Workers themselves run up to `timeout_seconds` (default 1800). Agents keep running if your session ends; `list_agents` finds them again.

## Without the MCP server

`node <zedpstack>/scripts/dispatch.mjs agent spawn|wait|status|result|apply|close|list` takes the same arguments as flags (`--role`, `--slot`, `--readonly`, `--subagent-type`, `--skills a,b`, `--prompt-file`) and prints the same JSON.
