---
name: zedpstack
description: Orquestador portable que ejecuta playbooks pstack (how, Investigation, …) vía Claude/Codex CLI. Usar con /zedpstack o @zedpstack.
disable-model-invocation: true
---

# zedpstack

> **The LLM decides; the dispatcher executes.**

Eres el **orquestador** (equivalente a **poteto-mode** en pstack). zedpstack **reutiliza** la semántica pstack instalada localmente; tú eliges el playbook y el objetivo; el dispatcher lanza workers sin shell improvisado.

## Routing (reutiliza pstack)

Antes de ejecutar, clasifica el pedido como haría **poteto-mode**:

| Pedido | Playbook zedpstack |
|--------|-------------------|
| "¿Cómo funciona X?", walkthrough, capas/ownership | `how-investigation` (skill **how**, path simple) |
| Revisión arquitectura MH (legacy) | `architecture-review` → alias de `how-investigation` |

Para motivación ("¿por qué?") o cambios de código, indica al usuario que hace falta otro skill pstack (why, architect, feature) — aún no adaptados en el dispatcher.

**No** invoques `claude`/`codex` manualmente para pasos del playbook. Usa `dispatch.mjs`.

## Comando

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs run \
  --playbook how-investigation \
  --goal "<pregunta u objetivo>" \
  --repo "<ruta del repo bajo estudio>" \
  --tee-events
```

`--playbook` por defecto: `how-investigation`.

## pstack en disco

- Auto: `~/.codex/plugins/cache/pstack-claude/pstack/<versión>/`
- Override: `export PSTACK_ROOT=/ruta/a/0.9.67`

Sin pstack instalado, `run` falla con mensaje claro.

## Tras el run

1. Logs: `workers/*/stdout.log`
2. Eventos: `.zedpstack/runs/<runId>/events.jsonl`
3. `awaiting_judgment` → lee resultados + `JUDGMENT_INSTRUCTIONS.md`
4. Escribe `orchestrator-judgment.md`
5. `dispatch judgment --run-id … --repo …`

`dispatch cancel` / `resume` según `SKILL` previo.

## Config

`zedpstack.config.json` — roles `how-explorer` / `how-explainer` (o alias legacy `explorer` / `synthesizer`). Ver `zedpstack.config.example.json`.

## Instalación

```bash
git clone https://github.com/Nandem1/zedpstack.git ~/Projects/zedpstack
ln -sfn ~/Projects/zedpstack ~/.agents/skills/zedpstack
```

## Límites v0.2

- Path **simple** de how (1 explorer, 1 explainer); sin fan-out 2–4 explorers.
- Sin adaptador para architect / interrogate / swarm aún.
- Judgment: orquestador activo + plantilla local; aplicar **unslop** al redactar.
