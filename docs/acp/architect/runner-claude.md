# Candidato de arquitectura de Claude

Modelo: opus-5-5
Runtime: claude
Fecha: 2026-10-17

Candidato de diseño del corte de arquitectura; la decisión final está en docs/ACP_DESIGN.md

I have the grounding I need: the spike server, the lifecycle and store, the MCP adapter, the worker runner, model routing, setup probing, the edit guard and the fake CLIs. Writing the candidate design now.

# Candidate design: zedpstack ACP orchestrator — "the ACP middlebox"

## Assumptions (no one to ask mid-run)
- **A1.** I could not fetch agentclientprotocol.com (no web tool here). The ACP v1 shapes below for `configOptions`, `session/set_config_option`, `config_option_update`, `session/request_permission`, and `fs/*` and `terminal/*` client methods come from memory. Slice 1 starts with a schema check against the spec repo.
- **A2.** Mature ACP adapters exist that Zed itself launches: `claude-agent-acp` (the Claude Agent SDK) and `codex-acp`. They handle multiple sessions, advertise their own model and mode selectors, and send `session/request_permission`. They also accept `mcpServers` in `session/new`. I treat these as **external binaries, not npm dependencies**, so the repo stays zero-dep.
- **A3.** Cursor's `agent` CLI has no ACP mode I can rely on. The design covers it with a small shim of our own that speaks ACP, so the hub still has only one engine shape.
- **A4.** Zed renders `tool_call` and `tool_call_update` for a session even when no prompt turn is open. If that is wrong, the fallback is in Open questions.
- **A5.** Memory says "zedpstack only replaces the Agent tool". The brief's product goal overrides this for the Zed UI. The design keeps the spirit: zedpstack never orchestrates. A real CLI agent runs poteto-mode, and zedpstack only hosts it, overlays worker cards and enforces policy.

## Problem
The spike (`src/acp/server.mjs:85-155`) parses commands and has no LLM. The user wants the zedpstack thread in Zed to *be* the orchestrator: pick a runtime, pick models from footer dropdowns, talk to a poteto-mode LLM, and see every worker as a live card. That holds even when the worker was spawned by the orchestrator's own MCP child process rather than by the ACP process.

Five constraints make the shape non-obvious:

1. **Workers live in other processes.** `spawnAgent` launches detached runners (`lifecycle.mjs:152-158`), and the orchestrator's MCP server is a grandchild. The ACP process can therefore learn about a worker only through the store.
2. **The store has real lost-update races today.** `spawnAgent` writes `runnerPid` with a read-modify-write at `lifecycle.mjs:160` while the runner writes `status:'running'` at `:166`; either can overwrite the other. Readers also write (`reconcile`, `:238-248`), and so do `stopAgent` (`:344`) and `closeAgent` (`:375`).
3. **Zed uses one agent process for every thread.**
4. **Unpinned aliases drift.** `opus` silently ran `claude-opus-4-8` (`PROBLEMAS_ACTUALES.md:7`). The effective model is already captured (`activity.mjs:48,84` → `effectiveModel`) but never compared with what was asked for.
5. **MCP hosts must keep working unchanged** (`src/mcp/tools.mjs`).

## Usage (caller's view)

**User in Zed:**
```
(new zedpstack thread)       footer: [Runtime: Claude ▾] [Model: opus ▾] [Mode: Default ▾]
> /codex                     → footer swaps to Codex's own model/effort/sandbox selectors
> fix the flaky retry test in src/net
  (assistant text streams from the orchestrator LLM, its own tool cards/diffs/thinking intact)
  ▸ Bug fix: reproduce flake · gpt-6.1-sol (codex)            [worker card, expandable]
  ▸ How: retry state machine · haiku → claude-haiku-4-5 ✓     [worker card]
  ⚠ Permission: apply_agent_changes bug-fix-3e9f3a → host tree?  [Allow once] [Reject]
```

**Settings.json:** unchanged from the spike (`scripts/acp.mjs`). An optional `~/.zedpstack/config` block overrides child commands:
```json
{ "acp": { "engines": {
  "claude": { "command": "claude-agent-acp" },
  "codex":  { "command": "codex-acp" },
  "cursor": { "command": "node", "args": ["<zedpstack>/scripts/acp-shim-cursor.mjs"] } } } }
```

**Call sites in our code (derived spec):**
```js
// src/acp/server.mjs — the whole entry
const zed = createPeer(process.stdin, process.stdout);
const hub = createHub({ zed, env: process.env });
zed.onRequest(hub.handle);          // initialize, session/new, session/prompt, set_config_option, set_mode…
zed.onNotification(hub.notify);     // session/cancel
process.on('exit', hub.shutdown);

// src/mcp/tools.mjs — apply_agent_changes handler
handler: async (args) => {
  const ok = await askHuman({ action: 'apply', agentId: args.agent_id, detail: diffStat }); // no-op allow outside ACP
  if (!ok.allowed) return { agent_id: args.agent_id, applied: false, error: 'rejected by user' };
  return applyAgentChanges({ repo: defaultRepo(args), id: args.agent_id });
}

// src/agents/lifecycle.mjs — status is derived, never repaired by writes
const view = loadAgent(repoRoot, id);   // { spec, run, stop, status, modelCheck }
```

## Shape

### Load-bearing decision (question A): proxy ACP to a child ACP agent
Each zedpstack session owns exactly **one child ACP agent process** (an *engine*) for its runtime. The hub forwards ACP almost transparently. It steps in at **five points** only:

1. **`session/new`.** Inject the zedpstack MCP server into `mcpServers`, with env `ZEDPSTACK_ACP_SESSION=<ourSessionId>`, `ZEDPSTACK_ACP_BRIDGE=<socket>` and `ZEDPSTACK_REPO=<cwd>`.
2. **First prompt.** Prepend `orchestratorPrompt()` (`mcp/server.mjs:32`, the SKILL.md body) as a leading text block, sent once per engine session.
3. **Options and commands.** Merge our `zp.runtime` select and our commands (`/claude`, `/codex`, `/cursor`, `/board`, `/spawn`) into the child's `configOptions` and `available_commands_update`. Route option changes by id prefix.
4. **Worker cards.** Overlay a card for every agent whose `spec.origin.sessionId` matches this session, using the existing `createWorkerUpdateSink` (`updates.mjs:78`).
5. **Client-method policy.** The child's `fs/write_text_file` and `terminal/create` requests to Zed pass through `guard.decide` (`guard.mjs:186`) and are refused with an ACP error when the orchestrator would edit the repo.

Results of this choice:

- **Conversation continuity** is the child's job: one engine session per thread, resumed natively.
- **The CLI's own UI survives intact**: its tool cards, diffs, thinking, plans and permission prompts pass through unchanged.
- **Model, effort and mode dropdowns** are the child's own options, so they are always the real list for that CLI. zedpstack keeps no hand-synced model catalog for the orchestrator.

### Data structures
```js
/** @typedef {'claude'|'codex'|'cursor'} Runtime */

/** Store: one writer per file (separate-before-serializing). */
/** @typedef {{ version: 2, id: string, createdAt: string, binding: Binding, role: string|null,
 *   description: string|null, cwd: string, repoRoot: string, isolation: 'worktree'|'none', worktree: object|null,
 *   timeoutMs: number, notes: string[],
 *   origin: { frontend: 'acp'|'mcp'|'cli', sessionId: string|null, pid: number },
 *   expectedModel: string|null }} AgentSpec      // agent.json — written once by spawnAgent (O_EXCL), never updated */
/** @typedef {{ runnerPid: number, workerPid: number|null, startedAt: string, effectiveModel: string|null,
 *   outcome: null | { ok: boolean, exitCode: number, timedOut: boolean, error: string|null,
 *                     changes: object|null, changeError: string|null, finishedAt: string } }} RunState
 *                                                // run.json — runner process only; atomic tmp+rename */
/** @typedef {{ requestedAt: string, by: string }} StopMark   // stop.json — O_EXCL create, idempotent */
/** @typedef {{ removedAt: string, branchDeleted: boolean }} CleanupMark // cleanup.json — closeAgent only */

/** Merged at the read boundary; never persisted. */
/** @typedef {{ spec: AgentSpec, run: RunState|null, stop: StopMark|null, cleanup: CleanupMark|null,
 *   status: 'starting'|'running'|'completed'|'failed'|'stopped', modelCheck: ModelCheck }} AgentView */

/** @typedef {{ state: 'ok'|'unverified'|'mismatch', requested: string, effective: string|null,
 *   expected: string|null }} ModelCheck */

/** ACP hub-side session. */
/** @typedef {{ id: string, cwd: string, runtime: Runtime, engine: EngineHandle|null,
 *   primed: boolean, turn: { startedAt: string, controller: AbortController }|null,
 *   cards: WorkerCards, childOptions: ConfigOption[], childCommands: object[] }} HubSession */

/** @typedef {{ runtime: Runtime, childSessionId: string, peer: Peer, pid: number,
 *   newSessionResult: object, kill: () => Promise<void> }} EngineHandle */

/** ~/.zedpstack/acp-prefs.json — owner: options.mjs */
/** @typedef {{ lastRuntime: Runtime, perRuntime: Record<Runtime, Record<string,string>> }} AcpPrefs */
```

**Status derivation** is a pure function: `deriveStatus(spec, run, stop, alive(run.runnerPid), now)`.
- `stop` → `stopped`. Stop is sticky by construction, which replaces the patch at `store.mjs:61`.
- `outcome` → `completed` or `failed`.
- A run whose runner is alive → `running`.
- No run inside the 15 s grace window → `starting`.
- Anything else → `failed: 'runner exited without finishing'`.

`reconcile` stops writing, so readers never write.

**Migration.** A v1 `agent.json` (has `status`) is read through a legacy adapter in `store.mjs` that returns an `AgentView`.

### Module map (question B): no `src/core`
`lifecycle.mjs` already is the frontend-agnostic facade. A new `src/core` would only forward the same calls, which is a pass-through layer.

| Module | Owns | Public surface |
|---|---|---|
| `src/agents/store.mjs` | file layout, per-actor files, `deriveStatus`, v1 adapter | `createSpec`, `writeRun`, `markStop`, `markCleanup`, `loadAgent`, `listAgentIds`, `agentsRoot` |
| `src/agents/lifecycle.mjs` | unchanged API; adds `origin` and `expectedModel`; status reads go through `loadAgent` | as today |
| `src/modelCheck.mjs` (new) | requested vs effective vs expected (pinned slug or probe cache `effective`) | `expectedModelFor(binding)`, `checkModel(requested, effective, expected) → ModelCheck` |
| `src/mcp/tools.mjs` | sets `origin` from env; asks before risky actions | adds `askHuman` usage only |
| `src/acp/rpc.mjs` (new) | bidirectional line JSON-RPC peer (requests both ways, response correlation). The spike's reader drops client responses (`server.mjs:182`) | `createPeer(in, out) → { request, notify, onRequest, onNotification, close }` |
| `src/acp/hub.mjs` (new) | session table, the five interception points, turn/cancel semantics, shutdown | `createHub({ zed, env }) → { handle, notify, shutdown }` |
| `src/acp/engine.mjs` (new) | resolve child command, spawn in its own process group, `initialize` + `session/new` with injected MCP, parent watchdog, kill | `startEngine({ runtime, cwd, mcpServer, env }) → Promise<EngineHandle>` |
| `src/acp/options.mjs` (new, pure + prefs IO) | merge `zp.runtime` with child options; route ids; merge commands; prefs | `mergeOptions`, `routeOption(id) → 'hub'\|'child'`, `mergeCommands`, `loadPrefs`, `savePrefs` |
| `src/acp/cards.mjs` (replaces `follow.mjs`; reuses `updates.mjs`) | store watcher (`fs.watch` on `agents/` + 500 ms poll fallback), origin filter, one sink per agent, re-emit on turn start | `createWorkerCards({ repo, sessionId, notify }) → { start, resync, stopTurnAgents(sinceIso), dispose }` |
| `src/acp/bridge.mjs` (new) | Unix socket `~/.zedpstack/run/acp-<pid>.sock`; maps `askHuman` to `session/request_permission` on the right session | server: `startBridge(hub)`; client: `askHuman(req) → {allowed}`. Allows immediately when `ZEDPSTACK_ACP_BRIDGE` is unset, so MCP hosts are unchanged |
| `src/acp/commands.mjs` | adds runtime commands to the existing parser | `parsePromptCommand` returns `{type:'runtime', runtime}` too |
| `src/acp/shim/cursor.mjs` + `scripts/acp-shim-cursor.mjs` (new) | ACP agent wrapping `agent -p --resume <chatId> --output-format stream-json` | is an ACP agent; no in-repo callers |

**Worker activity reaches the thread through one path.** The orchestrator's MCP child calls `spawnAgent`, which writes `agent.json` with `origin.sessionId` from env. The hub's `cards.mjs` watcher discovers the new id, filters on origin, and attaches the existing follow and sink to drive the card. The store is the only source; there is no push channel for activity.

### Config options (question C)
- **Our only option** is `{ id:'zp.runtime', name:'Orchestrator', category:'zedpstack', type:'select', currentValue, options:[claude, codex, cursor] }`. Runtimes whose engine binary is missing are listed with "(not installed)" in their description, using `RUNTIME_BINARIES` plus the engine command check.
- **All other options are the child's**, unchanged, and their ids are routed to the child. `modes` and `models` (the legacy fields) also pass through, so `session/set_mode` is forwarded unchanged.
- **`/claude`** as the first line, or picking it in the runtime dropdown, does the same thing:
  1. If the runtime differs, kill the engine and start a new one.
  2. Write a one-line `agent_message_chunk` ("switched to Claude; the conversation restarts").
  3. Re-apply that runtime's saved choices with `set_config_option` calls replayed to the child.
  4. Emit `config_option_update` with the merged list.
- **Persistence.** Every successful option change records `perRuntime[runtime][id] = value` and `lastRuntime`. `session/new` starts the engine for `lastRuntime` eagerly, defaulting to `claude`, so the first message needs no `/claude`.
- **Requested vs effective for the orchestrator.** After the engine reports its current model (`currentValue` of the child's model-category option, or the init model line in the shim), compare it to the requested value with `checkModel`. On a mismatch, emit a ⚠ `agent_message_chunk`.
- **Requested vs effective for workers.** `spec.expectedModel = expectedModelFor(binding)`: the pinned id when the slug is already concrete, otherwise the probe cache `effective` from `setupWizard.mjs:204`. When the runner writes `effectiveModel`, `loadAgent` derives `modelCheck`. Card title, board row and `agent_result` show `opus → claude-opus-4-8 ⚠ expected claude-opus-5-5`.
- **Closing PROBLEMAS.** `setup_write` pins aliases to the probed concrete id when they differ, so new sheets never store a drifting alias.

### Concurrency and hardening (question D)
- **No locks.** Every file has a single writer (spawn, runner, stopper, closer) and readers merge, per separate-before-serializing. Writes use tmp+rename (already the case, `store.mjs:48-50`). `markStop` uses `O_EXCL`, so a second stop is a no-op (idempotent). This removes the race at `lifecycle.mjs:160` vs `:166` by construction.
- **Supervision.**
  - Engines are spawned `detached:true` (their own group), so `kill(-pid)` also takes their MCP grandchild.
  - `hub.shutdown` runs on stdin close, SIGTERM, SIGINT and `uncaughtException`. It sends SIGTERM to every engine group and SIGKILL after 3 s.
  - The engine env carries `ZEDPSTACK_PARENT_PID`. Our shim and our MCP server poll it every 2 s and exit when it is gone. Third-party engines exit on stdin EOF.
  - Workers stay detached on purpose (D-03): they survive the hub and are bounded by `timeoutMs`.
- **Cancel semantics.** `session/cancel`:
  1. Forward `session/cancel` to the child.
  2. Abort the hub turn.
  3. Run `cards.stopTurnAgents(turn.startedAt)`, which closes non-terminal agents with this `origin.sessionId` and `createdAt ≥` turn start.

  Workers from earlier turns keep running, because the orchestrator may still be waiting on them. The `stopReason` comes from the child's response.
- **One process, many threads.** The `HubSession` table is keyed by our session id. Each session has its own engine, so one engine crash kills one thread only. An engine crash during a turn turns into `stopReason:'refusal'` plus a chunk explaining it, and `engine:null`. The next prompt restarts the engine; the earlier conversation is lost, and the chunk says so.
- **Permissions.**
  - The child's own `session/request_permission` passes through unchanged.
  - zedpstack-originated asks go through the bridge: `apply_agent_changes`, a writer with `isolation:'none'`, and `close_agent` with `delete_branch`. The hub issues `session/request_permission` with options `allow_once` / `allow_always` / `reject_once`; `allow_always` is remembered per session and action.
  - If the bridge times out after 10 min, or the turn is cancelled, the answer is `rejected`.
- **Edit guard.** The hub refuses the child's `fs/write_text_file` inside the repo, outside `.zedpstack`, unless `editsAllowed`. It also refuses `terminal/create` commands that `bashLooksLikeRepoWrite` flags. The existing hook (`guard.mjs`) stays as a backstop for edits the engine does internally.

### Sequence: one orchestrated turn that spawns workers
```
Zed            Hub(acp)                  Engine(claude-agent-acp)    MCP(zedpstack, child of engine)   Runner/Worker      Store
 │ session/prompt ─▶│ turn={startedAt}; primed? no → prepend SKILL body
 │                  │ cards.resync()  ───────────────────────────────────────────────────────────────────────────────▶ read
 │                  │ session/prompt ─▶│
 │◀─ agent_message_chunk ◀── (passthrough)│
 │◀─ tool_call(mcp spawn_agent) ◀────────│── tools/call spawn_agent ─▶│ spawnAgent(origin.sessionId) ─▶ createSpec ──▶ agent.json
 │                  │                    │                           │                    detached runner ─▶ run.json
 │                  │ watcher: new id, origin matches → sink.emitStart ◀──────────────────────────────────────────── watch
 │◀─ tool_call zp-<id> (kind other) ◀───│
 │◀─ tool_call_update (throttled 250ms) │ follow: progress.log/stdout.log ◀───────────────────── worker writes logs
 │                  │                    │── tools/call wait_agent ─▶│ waitAgents (polls loadAgent)
 │                  │                    │── tools/call apply_agent_changes ─▶│ askHuman ─bridge─▶│
 │◀─ session/request_permission ◀───────│ (hub issues on our sessionId)
 │── outcome allow_once ─▶│ ─bridge reply─▶ apply → cherry-pick
 │◀─ tool_call_update completed (final summary + modelCheck) ◀─ sink.finish
 │◀─ result {stopReason:end_turn} ◀── child result
```

### What it deliberately does not do
- It never parses CLI stream-json for the orchestrator. The child already does that.
- It never orchestrates or routes: poteto-mode runs inside the child.
- It keeps no model catalog for the orchestrator.
- It never kills workers from earlier turns on cancel.
- It never holds a lock.

### Interface depth
- **Zed sees one agent.**
- **The hub's public surface** is three functions (`handle`, `notify`, `shutdown`). Behind them sit engine supervision, option merging, card overlay, permissions and the edit guard.
- **`askHuman`** is one call whose semantics stay correct in both frontends.
- **`loadAgent`** replaces four write paths with one pure read.

The risk sits in the five interception points; everything else is pass-through by design. The pass-through is the protocol itself rather than a method layer, so the pass-through red flag does not apply.

## Tradeoffs accepted
- We accept a runtime dependency on third-party ACP adapters that may drift, in exchange for the CLI's full UI (diffs, thinking, native permissions, real model lists) at zero parsing cost. Exposure is limited to five interception points.
- We accept losing the conversation when switching runtime or after an engine crash, in exchange for no continuity state of our own.
- We accept one engine process per thread (memory), in exchange for crash isolation and no session multiplexing bugs.
- We accept a Unix socket for permissions, a second IPC path besides the store. It carries *only* human decisions, which cannot be derived from files. Activity never uses it.
- We accept a store format migration (v2 split files plus a v1 read adapter), in exchange for removing every read-modify-write race without a lock.
- We accept that cancel leaves workers from earlier turns running. Stopping the thread's whole fleet stays explicit (`/board` then close, or the orchestrator's `close_agent`).

## Alternatives considered
- **Headless CLI per turn** (`claude -p --resume --output-format stream-json`, `codex exec resume`, `agent -p --resume`), parsed into ACP. It hides little and exposes much. We would re-implement tool cards, diffs, thinking and plans three times. Claude permission prompts would need `--permission-prompt-tool` plumbing. The model and mode lists would have to be curated by hand, which is a hand-synced list. Continuity would depend on resume ids we must persist. Rejected as the main shape; it survives only *inside* the Cursor shim, where no ACP agent exists.
- **Hub multiplexes one engine per runtime across all threads.** Fewer processes, but one crash kills every thread, and per-session env (session id for origin) would need per-session MCP configs anyway. Rejected.
- **Push channel (MCP → hub) for worker events instead of a store watcher.** Lower latency, but activity would have two sources: workers spawned from `dispatch` CLI or another frontend would be missing, and replay after reconnect would break. Rejected, per single source of truth.
- **`src/core` facade.** It would be a pass-through over `lifecycle.mjs`. Rejected.

## Implementation reconciliation
*(Empty until implementation starts.)*

## Open questions and risks
- Does Zed 1.24.2 render `tool_call_update` for a session outside an open `session/prompt`? If not, should cards update only during turns, with `cards.resync()` at each turn start catching up (already in the design)?
- Do `claude-agent-acp` and `codex-acp` send file edits through client `fs/write_text_file` and shell through `terminal/create`? If they run them internally, the edit guard at the protocol boundary sees nothing, and the PreToolUse hook is the only guard for Claude. Is that acceptable for Codex?
- Is there a Cursor ACP mode now (`agent acp` or similar)? If so, should the shim be dropped before it is built?
- Should `allow_always` for `apply_agent_changes` last only for the session, or be persisted in prefs?
- Is prepending the SKILL body to the first user message acceptable, or should we use an engine-specific system-prompt `_meta` (for example `claude-agent-acp`'s) where one exists?
- If `config_option` ids collide (a child uses `runtime`), we rely on the `zp.` prefix. Is that enough?
- **Risk:** engine binaries are found through PATH and Zed's external-agents directory, so `doctor` must report which binary and version each runtime resolves to.

## Ordered slices (question E)
1. **`/claude`, dropdowns and a plain streamed turn.**
   - Build: `rpc.mjs`, `engine.mjs` (claude only), `hub.mjs` passthrough with `zp.runtime` merged and `/claude` parsed.
   - Test: new `tests/fixtures/bin/fake-acp-agent.cjs`, with one model option, which streams a chunk.
   - Check: a test asserts merged `configOptions`, a `config_option_update` after `/claude`, and a streamed chunk. Manually in Zed, the footer shows Orchestrator plus Claude's model dropdown and a reply streams.
2. **Store split and derived status.** Build `store.mjs` v2, `loadAgent`, the v1 adapter and `origin`. Check: a race test where stop and outcome are written concurrently and the result is `stopped`; readers never write; all existing tests pass.
3. **Injection and worker cards.** Add MCP injection with session env, the SKILL prepend, and the `cards.mjs` watcher. Check: a fake ACP child calls `spawnAgent` with origin env against fake CLIs, and a `zp-<id>` card goes from pending to completed. In Zed, ask the orchestrator for an investigation.
4. **Cancel and supervision.** Build cancel forwarding, `stopTurnAgents`, group kill, the parent watchdog and `shutdown`. Check: FAKE_SLEEP worker plus cancel gives `stopped` and `stopReason:cancelled`; killing the hub leaves no engine pid.
5. **Model check.** Build `modelCheck.mjs`, wire it into worker cards and board rows plus the orchestrator mismatch chunk and the `setup_write` pinning. Check: fake CLI `opus` → `claude-opus-fake` with expected `claude-opus-5-5` gives a `mismatch` row.
6. **Permissions and edit guard.** Build `bridge.mjs`, `askHuman` in tools, and the fs/terminal interception. Check: the fake child applies, permission is rejected, and the result is `applied:false`; MCP-host tests are unchanged.
7. **Codex and Cursor engines.** Add `/codex` through `codex-acp` and `/cursor` through the shim (fake `agent` fixture). Add prefs persistence and replay. Check: switching runtime restores the saved choices.
8. **Multi-thread hardening.** Two sessions with engines and cards isolated; one engine crash leaves the other thread running.

## Next implementation step
Write `src/acp/rpc.mjs` (a bidirectional peer) and `tests/fixtures/bin/fake-acp-agent.cjs`. Then build slice 1's hub passthrough against the fake engine, with the `zp.runtime` option merged into the child's `configOptions`.

## What I did
I read the architect skill and its runner prompt, rationale template and red flags, plus the brief. I also read these repo files:
- `src/acp/{server,commands,follow,updates}.mjs`
- `src/agents/{lifecycle,store}.mjs`
- `src/mcp/{server,tools}.mjs`
- `src/runtimes/{worker,activity}.mjs`
- `src/{workerModels,permissions,guard,orchestratorHost,manifestLock}.mjs`
- `src/setupWizard.mjs` (lines 1–250)
- `docs/{ARCHITECTURE,ACP_SPIKE}.md`, `PROBLEMAS_ACTUALES.md`, `SKILL.md`
- `tests/fixtures/bin/fake-cli.cjs`

I changed no files. I could not check the ACP v1 schema against the spec (no web access), so it remains unverified (A1).
