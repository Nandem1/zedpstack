# Session 1.1b — evidencia

## Cambios

- Eliminado bypass `allStepsDone`; siempre `executeStep` → `canReuseCompletedStep`.
- Explorer: `readSuccess >= 1` obligatorio.
- Identidad: `repoCommit` + `repoSourceFingerprint` (AGENTS, plan ARQ, API README).
- Dedupe Claude `result` terminal; judgment rechaza placeholders; `text` no-string sin TypeError.

## Tests

`npm test` → **16/16** (pre-1.2)

## Evidencia manual

- Resume `awaiting_judgment` en run `1f56f359…`: eventos `step.completed` con `reuse: true` (explore + synthesize) en ~280 ms.
- Resume `completed`: `skipped: already_completed`.

## Auditorías

- `docs/audit-1.1b-codex-last.txt` — NO-GO parcial antes de fingerprint de fuentes; revalidar tras commit de 1.1b.
- `docs/audit-1.1b-claude.txt`
