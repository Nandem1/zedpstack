---
name: setup-zedpstack
description: Configure which worker CLI and model zedpstack spawns for each pstack role, and register zedpstack with the host. Use for /setup-zedpstack, "configure zedpstack models", or when doctor reports problems.
disable-model-invocation: true
---

# setup-zedpstack

The worker sheet `~/.zedpstack/pstack-models.md` (override with `ZEDPSTACK_MODEL_SHEET`) uses the same role lines as `/setup-pstack`. What differs is the values: each one is a slug a worker CLI can spawn, not a slug for your host's subagent tool. `spawn_agent {"role": ...}` reads it on every call, so edits apply at once.

`Z` below is `node <zedpstack>/scripts/dispatch.mjs`.

## 1. Inspect

Run `$Z doctor --human`. It shows the pstack install, which worker CLIs exist, every role with the runtime and model it spawns, host registration, and problems. Show the user the roles section and the problems verbatim.

## 2. Detect models

Never write a slug you have not seen listed. Per runtime:

| Runtime | CLI | How to list | Typical slugs |
|---------|-----|-------------|---------------|
| `claude` | `claude -p` | the family aliases `claude --help` names under `--model` | `haiku`, `sonnet`, `opus`, `fable` |
| `codex` | `codex exec` | the models configured in `~/.codex/config.toml` and the Codex model picker | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna` |
| `cursor` | `agent -p` | `agent --list-models` | `composer-2.5`, `grok-*`, plus Claude and GPT models served by Cursor |

The runtime is inferred from the slug. When a slug exists on more than one CLI (Cursor also serves Claude and GPT models), prefix it: `cursor:claude-opus-5-5`, `codex:gpt-6-sol`, `claude:opus`.

## 3. Choose with the user

Start from the current sheet, or from `$Z setup init` if it is missing. Show every role with its current value and ask whether to keep it or change specific roles, offering the detected slugs. Prefer the host's structured question tool; plain text otherwise.

- Panel rows (`arena runners`, `architect runners`, `interrogate reviewers`, `arena cross-judge pool`) are lists. One worker runs per entry, so the length sets the fan-out. Recommend different runtimes across a panel: the adversarial signal comes from model diversity.
- A value may carry an effort, `gpt-6.1-sol @high`. `default effort` sets it for values without one; `session` sets none.
- `inherit-parent` and `auto` cannot be honored by a separate CLI; zedpstack runs the pstack default instead. Recommend a concrete slug.
- Rows only the batch playbooks use (`architect ground`, `architect synthesize`, `interrogate lead`, `reflect judgment`, `reflect divergent`, `reflect synthesizer`) may stay.

## 4. Write and verify

Overwrite the whole sheet with the chosen rows, keeping the header comment. Then run `$Z models` and `$Z doctor --human` and confirm there are no problems. For the batch playbooks (`dispatch run`), also run `$Z setup apply --dry-run`, show the diff, and `$Z setup apply` after the user agrees.

## 5. Register hosts

If doctor shows a host as not ready, run `$Z install --host <host>` to preview and `--apply` to write. Claude Code, Codex and Cursor are automatic. Zed needs the printed `context_servers` snippet merged into its settings by hand. Tell the user to restart the host so it loads the MCP server.
