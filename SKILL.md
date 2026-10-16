---
name: zedpstack
description: Ejecuta skills pstack (how, why, architect, interrogate, reflect) vía Claude/Codex CLI. /zedpstack + objetivo.
disable-model-invocation: true
---

# zedpstack

> **The LLM decides; the dispatcher executes.**

Orquestador = **poteto-mode** (routing). Workers = `dispatch.mjs` (lee prompts desde `PSTACK_ROOT`).

## Routing

| Intención | `--playbook` |
|-----------|----------------|
| Cómo funciona X, capas, ownership | `how-investigation` (default) |
| Por qué / rationale / historia | `why-rationale` |
| Diseñar antes de codear | `architect-sketch` |
| Review adversarial / stress test | `interrogate-review` + `--context-file` (diff) |
| Reflect sobre sesión | `reflect-session` + `--context-file` (transcript digest) |

`architecture-review` → alias deprecado de `how-investigation`.

No uses playbooks de **escritura** (feature, bug-fix) aquí: zedpstack v0.3 es read-only.

## Comando

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs run \
  --goal "<objetivo>" \
  --repo "<repo>" \
  --context-file /path/to/diff-or-transcript.md \
  --tee-events
```

`PSTACK_ROOT` opcional; default: cache Codex `pstack-claude`.

## Judgment

Tras `awaiting_judgment`: lee workers, escribe `orchestrator-judgment.md`, `dispatch judgment`.

Ver [docs/PSTACK_ADAPTERS.md](./docs/PSTACK_ADAPTERS.md).
