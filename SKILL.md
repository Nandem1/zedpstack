---
name: zedpstack
description: Ejecuta skills pstack (how, why, architect, interrogate, reflect) vía Claude/Codex CLI. /zedpstack + objetivo. Usa /setup-zedpstack para modelos.
disable-model-invocation: true
---

# zedpstack

> **The LLM decides; the dispatcher executes.**

Orquestador = **poteto-mode** (routing en este chat). Workers = `dispatch.mjs` (prompts desde `PSTACK_ROOT`, spawn CLI, manifest, validación).

## Antes del primer run

1. `cp zedpstack.config.example.json zedpstack.config.json` (en el clon del paquete).
2. **`/setup-zedpstack`** o `dispatch setup init` + editar hoja + `dispatch setup apply`.
3. `npm test` en el paquete.

## Routing (`/zedpstack <objetivo>`)

| Intención | `--playbook` |
|-----------|----------------|
| Cómo funciona X | `how-investigation` (default) |
| Por qué / rationale | `why-rationale` |
| Diseño previo | `architect-sketch` |
| Review adversarial | `interrogate-review` + `--context-file` |
| Reflect sesión | `reflect-session` + `--context-file` |

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs run \
  --goal "<objetivo>" \
  --repo "<repo-absoluto>" \
  --playbook how-investigation \
  --tee-events
```

`list` playbooks: `dispatch list`.

## Ver progreso (streaming)

### Cursor / Composer no muestra el subprocess

Si el orquestador ejecuta `dispatch run` en un **bloque de terminal**, la UI solo enseña el comando hasta que **termina** (minutos). El stderr de `--tee-events` **no** se pinta en el chat.

**Patrón obligatorio en Cursor:**

1. Lanzar en segundo plano y obtener `runId` al instante:

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs run --detach \
     --goal "..." --repo "/ruta/repo" --playbook how-investigation
   ```

2. Seguir progreso legible (stdout, visible en salida del tool):

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs follow \
     --run-id <id> --repo "/ruta/repo" --from-start
   ```

3. O en **Terminal del IDE** (panel inferior):

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs watch --run-id <id> --repo "/ruta/repo" --from-start
   ```

4. O leer el archivo que el orquestador puede ir mostrando:

   `.zedpstack/runs/<id>/progress.log` (`Claude explorer — running`, `> Inspecting …`).

El orquestador debe **repostar** líneas nuevas de `progress.log` o `follow` en el chat cada ~15–30 s mientras corre el run.

| Modo | Uso |
|------|-----|
| **progress.log** | Siempre en el run dir (v0.5.1+) |
| **follow** | Progreso humano en stdout |
| **detach + follow** | Cursor-friendly |
| **JSONL** | `--tee-events` → stderr (solo terminal real) |
| **watch** | `events.jsonl` legible |

Chunks `worker.output` no se persisten en `events.jsonl` por defecto; usa `--persist-stream-events` para replay completo.

## Judgment

Tras `awaiting_judgment`: lee `workers/*/result.json`, escribe `orchestrator-judgment.md`, `dispatch judgment --run-id …`.

## Configuración de modelos

Skill dedicado: [setup-zedpstack/SKILL.md](./setup-zedpstack/SKILL.md) (misma hoja que pstack `setup-pstack`).

## Referencia

[docs/PSTACK_ADAPTERS.md](./docs/PSTACK_ADAPTERS.md) · [docs/STREAMING.md](./docs/STREAMING.md)
