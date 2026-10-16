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

| Modo | Uso |
|------|-----|
| **JSONL en vivo** | `--tee-events` en `run`/`resume` → stderr `[zedpstack] {...}` |
| **Seguimiento legible** | Terminal 2: `dispatch watch --run-id <id> --repo <repo> --from-start` |
| **Artefactos** | `.zedpstack/runs/<id>/events.jsonl`, `workers/*/stdout.log` |

Chunks `worker.output` no se persisten en `events.jsonl` por defecto (solo tee); usa `--persist-stream-events` si necesitas replay completo.

## Judgment

Tras `awaiting_judgment`: lee `workers/*/result.json`, escribe `orchestrator-judgment.md`, `dispatch judgment --run-id …`.

## Configuración de modelos

Skill dedicado: [setup-zedpstack/SKILL.md](./setup-zedpstack/SKILL.md) (misma hoja que pstack `setup-pstack`).

## Referencia

[docs/PSTACK_ADAPTERS.md](./docs/PSTACK_ADAPTERS.md) · [docs/STREAMING.md](./docs/STREAMING.md)
