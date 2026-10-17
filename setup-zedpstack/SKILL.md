---
name: setup-zedpstack
description: Configura workers zedpstack al estilo pstack — mostrar estado, routing por CLI, decisión del usuario. No copiar slugs Cursor→Claude.
disable-model-invocation: true
---

# setup-zedpstack

Filosofía **pstack**: el orquestador **muestra** cómo está configurado; si falta algo o hay conflicto, **el usuario decide** (preguntas en chat o edición de hoja). No ejecutar `apply` a ciegas desde la hoja de Cursor.

## Dos hojas

| Hoja | Ruta | Para qué |
|------|------|----------|
| Orquestador IDE | `~/.cursor/rules/pstack-models.mdc` | Task / composer / grok en Cursor |
| Workers dispatch | `~/.zedpstack/pstack-models.md` | `claude` / `codex` / `agent` spawn |

## Routing de modelos (workers)

| Slugs | Runtime | CLI |
|-------|---------|-----|
| `haiku`, `sonnet`, `opus` | `claude` | `claude -p` |
| `gpt-*`, `*-sol` | `codex` | `codex exec` |
| `composer-*`, `cursor-grok-*`, `grok-*`, `glm-*` | `cursor` | `agent -p --mode plan` |

Detalle: `docs/SETUP_ORCHESTRATOR_AND_ROUTING.md` en el clon `~/Projects/zedpstack`.

## Flujo del orquestador

1. `dispatch setup diagnose --human`
2. Si falta hoja workers: `setup init --file ~/.zedpstack/pstack-models.md`
3. Preguntar al usuario y editar filas worker (traducir slugs Cursor → runtime correcto)
4. `setup apply --dry-run --file ~/.zedpstack/pstack-models.md`
5. Tras confirmación: `setup apply --file ~/.zedpstack/pstack-models.md` (`--strict` opcional)
6. `setup show`

## Orquestador agnóstico

`ZEDPSTACK_ORCHESTRATOR=cursor|claude-code|codex|zed` — workers leen solo `zedpstack.config.json`.

## Progreso UI

`--tee-events` en TTY → líneas legibles; `dispatch watch --from-start` igual.
