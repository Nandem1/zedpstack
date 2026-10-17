# Catálogo de adaptadores pstack (modo batch)

> Desde v0.6 el camino principal es el orquestador poteto-mode con las herramientas MCP (`spawn_agent`, …), que cubren todos los playbooks de pstack, incluidos los de escritura. Ver [ARCHITECTURE.md](./ARCHITECTURE.md). Estos playbooks fijos sirven cuando no hay orquestador.

| Playbook | Skill pstack | Pasos (secuencial) | Contexto extra |
|----------|--------------|--------------------|----------------|
| `how-investigation` | how + investigation | explore → synthesize | — |
| `why-rationale` | why | investigate → synthesize | opcional en `--goal` |
| `architect-sketch` | architect (+ how ground) | ground → sketch-a/b → synthesize | — |
| `interrogate-review` | interrogate | review-a/b/c → lead | `--context-file` diff o archivos |
| `reflect-session` | reflect | 3 reviewers → synthesize | `--context-file` digest transcript |

Sin playbook batch: swarm, arena, feature, bug-fix, babysit y shipping. Usa el orquestador (`/zedpstack`).

Pasos sin dependencias mutuas (p. ej. `review-a/b/c`) se ejecutan en **ola paralela** (`step.wave.started`). Roles por panel: `interrogate-reviewer-a/b/c`, `architect-runner-a/b`, reflect por lente. Config: `/setup-zedpstack` → `dispatch setup apply` (reconcile de roles managed).

Observabilidad: `--tee-events`, `dispatch watch`, [STREAMING.md](./STREAMING.md).
