# Observabilidad y streaming (zedpstack)

## Eventos

Cada run escribe `.zedpstack/runs/<runId>/events.jsonl` (append-only).

Tipos habituales:

- `run.started` / `run.completed` / `run.failed`
- `step.started` / `step.completed` / `step.failed`
- `worker.spawned` / `worker.finished` / `worker.timeout`
- `worker.output` / `worker.stderr` (stream; por defecto **no** se guardan en disco)

## Flags CLI

| Flag | Efecto |
|------|--------|
| `--tee-events` | Copia cada evento a stderr del proceso `dispatch` (útil en Cursor mientras corres `run`) |
| `--persist-stream-events` | Persiste también `worker.output` / `worker.stderr` en `events.jsonl` |

## `dispatch watch`

En otra terminal, mientras el run avanza:

```bash
node ~/Projects/zedpstack/scripts/dispatch.mjs watch \
  --run-id <uuid> \
  --repo /path/to/repo \
  --from-start
```

Formatea líneas legibles (paso, worker, runtime/modelo, preview de output). Ctrl+C para salir.

## Logs por worker

Siempre en disco:

- `workers/<stepId>/stdout.log` — stream crudo del CLI
- `workers/<stepId>/stderr.log`
- `workers/<stepId>/result.json` — texto validado para el siguiente paso

Codex además: `codex-last-message.txt`.
