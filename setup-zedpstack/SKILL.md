---
name: setup-zedpstack
description: Configure which worker CLI and model zedpstack spawns for each pstack role, the way /setup-pstack does it - effort first, then current roles, then which roles to change and which model each gets. Use for /setup-zedpstack, "configure zedpstack models", or when doctor or the agent board reports a model problem.
disable-model-invocation: true
---

# setup-zedpstack

The worker sheet `~/.zedpstack/pstack-models.md` uses the `/setup-pstack` role lines. Each value is a model a worker CLI runs: Claude aliases on `claude -p`, GPT models on `codex exec`, Cursor's own models (Composer) on `agent -p`. `spawn_agent` reads it on every call.

Ask every question with your host's structured question tool (`AskUserQuestion` on Claude Code: at most 4 questions per call, 2 to 4 options each, "Other" is added for free text). On a host without one, ask the same questions as short numbered lists in plain text. Use the question text, options and descriptions from the plan as given; they are already sized for that limit.

The MCP tools are `setup_plan` and `setup_write`. Without the MCP server use `node <zedpstack>/scripts/dispatch.mjs setup plan` and `setup write --answers '<json>'`.

## 1. Load the plan

Call `setup_plan`. It probes each Claude alias against the account (cached a day; pass `refresh: true` after the user buys credits or upgrades the CLI), reads the GPT catalog Codex has for the account, and lists Cursor's first-party models. It returns:

- `roles`: every role with its current slots, `effective` (the model the CLI really runs for an alias), `source` (`sheet`, or `pstack-default` when the sheet has no line), and `problems`.
- `questions`: `effort`, `change`, `roleGroups`, `provider`, `models.<provider>`, `panel`.

## 2. Effort first

Ask `questions.effort`: `default`, `medium` or `high`. `default` keeps each CLI's own effort and is written as `session`. Remember the answer for step 6.

## 3. Show the current configuration

Show one table: role, model, what runs, status. Write `opus → claude-opus-4-8` when `effective` differs from the alias, mark `pstack-default` rows as "(default de pstack)", and put every problem under the table verbatim, for example "bug-fix: fable no corre (Fable 5 requires usage credits)".

## 4. Change anything?

Ask `questions.change`. When `problemCount` is above zero, say how many roles fail today, and make "Cambiar roles" the first option with "(Recommended)".

If the answer is "Mantener", skip to step 6 with no role changes.

## 5. Which roles, then which model

1. Ask all four `questions.roleGroups` in one call (multi-select). Name the roles with ⚠ in the text before the call. A role the user picks under "Other" is matched to the closest role line.
2. For each chosen non-panel role, ask `questions.provider` (Claude, GPT (Codex), Cursor), up to four roles per call, one question each with the role as header. Then ask the model with `questions.models.<provider>`. If the provider has more models than options, mention the `more` list and accept one of them through "Other".
3. For each chosen panel role (`architect runners`, `interrogate reviewers`, `arena`), ask `questions.panel` as a multi-select. Each selected option is one worker, so the count of selections sets the panel size. Recommend mixing providers for diversity. Accept an explicit ordered list such as `opus, gpt-6.1-sol, composer-2.5` through "Other".

Never offer a model that is not in the plan. Unusable models (like an alias that needs credits) are already left out.

## 6. Write

Call `setup_write` with `default_effort` from step 2 and `roles` with only the changed roles, each mapped to a list of model values (use the option `value`, which carries a `cursor:`/`codex:` prefix when needed). Example:

```json
{ "default_effort": "medium", "roles": { "bug-fix": ["gpt-6.1-sol"], "arena": ["opus", "gpt-6.1-sol", "composer-2.5"] } }
```

Roles you do not send keep their current line. If the call rejects a value, show the reason and ask that role again.

## 7. Confirm

Call `setup_plan` again and show the final table. It must report `problemCount: 0`; if not, go back to step 5 for the roles still listed. Tell the user where the sheet lives, that effort reaches Claude (`--effort`) and Codex but Cursor ignores it, and that the agent board shows the model each worker actually ran.

For the batch playbooks (`dispatch run`) also run `dispatch setup apply` so `zedpstack.config.json` follows the sheet.
