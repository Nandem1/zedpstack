---
name: zedpstack-bitacora
description: Use whenever something fails or surprises you during zedpstack work (a worker failed or hung, a test flaked, a tool errored, a status looked wrong, CI went red, a smoke test disagreed with a report). Decide in the moment whether to fix it now or log it, and write it to the project logbook so nothing is lost. Also use when asked to review the logbook.
---

# zedpstack bitácora

Failures during an autonomous run are data. Never let one stall the run and never let one vanish. Every failure gets one logbook entry and exactly one of two outcomes: fixed now, or open for later.

Logbook: `docs/BITACORA.md` in the zedpstack repo (tracked). Append entries at the bottom, newest last. While a run is in flight the orchestrator may keep a scratch copy in `.zedpstack/bitacora.md` (gitignored) and promotes it to `docs/BITACORA.md` through a delegated writer at the end of each slice, so lasting entries reach git. Never write secrets or account emails into it.

## Entry format

```
## <YYYY-MM-DD HH:MM> <short title>
- Estado: abierto | arreglado (<commit>) | descartado (<razón>)
- Síntoma: what was observed, with the exact message or command.
- Evidencia: file:line, log path, agent id, CI run id.
- Causa: root cause, or "desconocida" with the best hypothesis labeled as a guess.
- Acción: what was done now, or the next step if open.
```

## Decide in the moment

1. Reproduce or read the evidence first. A failure report from a worker is a claim, not a fact: check it against the code, the real status (`node scripts/dispatch.mjs agent status|result`), or a fresh run.
2. If the root cause is clear and the fix is one small delegated change (a bug-fix worker, one verification), fix it now, in its own commit, then mark the entry `arreglado`.
3. If it needs a design decision, a product call, or more than one slice of work, mark it `abierto` with the next step and keep driving the main predicate.
4. A flaky or misleading verifier (test that depends on the environment, stale monitor, wrong status) is a defect too: log it and fix it at the root, never retry until green.
5. Never rerun a hanging command more than twice. Stop the worker, rescue its tree, relay with a fresh worker and consolidated scope, and log the loop.

## Review

When asked to review, or at the end of a run, read the logbook, list `abierto` entries with their next step, and promote anything lasting (a recurring hazard, a rule for workers) into the repo docs or memory through a delegated writer.

## Known hazards (seed)

- A long-running MCP server or `dispatch top` from before an upgrade runs old code and mislabels new agent records as failed. Restart those processes after changing the store, and prefer `node scripts/dispatch.mjs agent ...` until you do.
- Zed reuses one ACP agent process across threads: kill the old `scripts/acp.mjs` after changing hub code.
- Workers run in sandboxes that may forbid env changes, sockets or network: ask them to say what they skipped, and run those checks yourself.
- Worker sandboxes may hit the owner's model quota mid-slice: relay with a fresh worker on another runtime and consolidated scope.
