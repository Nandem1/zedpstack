# Observabilidad y streaming (zedpstack)

## Agentes (`spawn_agent`)

Cada agente escribe en `<repo>/.zedpstack/agents/<id>/`:

| Archivo | Contenido |
|---------|-----------|
| `agent.json` | estado (`starting`, `running`, `completed`, `failed`, `stopped`), runtime, modelo, PIDs, worktree, cambios |
| `progress.log` | líneas legibles (`Claude how explorer — running (haiku)`, `> Inspecting src/…`) |
| `events.jsonl` | eventos de máquina |
| `prompt.md` / `task.md` | prompt completo enviado al worker / tarea original del orquestador |
| `stdout.log`, `stderr.log`, `result.json` | salida cruda e informe final |
| `runner.log` | errores del proceso runner |

`progress.log` recibe dos tipos de línea por agente: `> …` para herramientas (lecturas, búsquedas, comandos) y `· …` para la narración del modelo (la primera frase de cada mensaje de Claude, cada pensamiento de Cursor y cada bloque `codex` de Codex). Además, el modelo que reporta el CLI (`init` en Claude y Cursor, la cabecera `model:` en Codex) se guarda como `effectiveModel` en `agent.json`.

La lista (`src/agents/board.mjs`) toma la última de esas líneas por agente. Se ve en tres sitios: al principio de cada resultado MCP, en las notificaciones de progreso de `wait_agent` y en `dispatch top`.

`agent_status` (MCP) o `dispatch agent status --id <id>` muestra las últimas líneas de `progress.log`. El resto de este documento cubre el modo batch (`dispatch run`).


## Eventos

Cada run escribe `.zedpstack/runs/<runId>/events.jsonl` (append-only).

Tipos habituales:

- `run.started` / `run.completed` / `run.failed` / `run.cancelled`
- `run.awaiting_judgment` — workers listos; falta `dispatch judgment`
- `step.started` / `step.completed` / `step.validated`
- `worker.spawned` / `worker.completed` / `worker.failed` / `worker.timeout`
- `worker.output` / `worker.stderr` (stream; por defecto **no** se guardan en disco)

Un fallo de validación de worker emite `run.failed` (no hay `step.failed` separado hoy).

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

Formatea líneas legibles (paso, worker, runtime/modelo, preview acotado de output/stderr).
Con `--from-start` (recomendado) reproduce el historial y sigue el archivo.

`watch` sale solo al ver `run.completed`, `run.failed` o `run.cancelled` en el stream
(o con Ctrl+C si el run sigue activo, p. ej. en `awaiting_judgment`).

## Logs por worker

Siempre en disco:

- `workers/<stepId>/stdout.log` — stream crudo del CLI
- `workers/<stepId>/stderr.log`
- `workers/<stepId>/result.json` — payload crudo del runtime (la validación del paso decide si el resultado es aceptado)

Codex además: `codex-last-message.txt`.
