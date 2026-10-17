---
name: setup-zedpstack
description: Configura modelos y esfuerzo de workers zedpstack desde la hoja pstack (como /setup-pstack). Sincroniza a zedpstack.config.json.
disable-model-invocation: true
---

# setup-zedpstack

Alinea **zedpstack** con la hoja de modelos de **pstack** (`setup-pstack`): mismas filas por rol, runtime inferido (Claude vs Codex) y `effort` opcional (`slug @high`).

## Cuándo usarlo

- Primera instalación del paquete `~/Projects/zedpstack`
- Cambiar modelos de explorers/synthesizers/reviewers
- Tras editar `~/.cursor/rules/pstack-models.mdc` manualmente

## Pasos

1. **Detectar modelos** disponibles en esta sesión (Claude `Agent` / Codex slugs). No escribas slugs que no hayas confirmado.

2. **Hoja de override** (misma forma que pstack):

   - Cursor: `~/.cursor/rules/pstack-models.mdc` (recomendado; `alwaysApply` para el orquestador)
   - Alternativa: `~/.zedpstack/pstack-models.md`

   Si no existe:

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs setup init
   ```

3. **Editar filas** relevantes para workers (no solo orquestador):

   - `how explorer` / `how explainer`
   - `why investigators` / `why synthesizer`
   - `architect ground`, `architect runners` (2 modelos), `architect synthesize`
   - `interrogate reviewers` (3 modelos), `interrogate lead`
   - `reflect tooling`, `reflect judgment`, `reflect divergent`, `reflect synthesizer`
   - `default effort: session` o `low|medium|high|xhigh|max`

4. **Sincronizar a dispatch** (la hoja debe existir; si no, `setup init` primero):

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs setup apply
   ```

   La salida incluye `overflowWarnings` y `droppedLines` si la hoja tiene filas pstack no mapeadas o modelos de más en un panel.

5. **Verificar**:

   ```bash
   node ~/Projects/zedpstack/scripts/dispatch.mjs setup show
   ```

## Effort

zedpstack guarda `effort` en `zedpstack.config.json` por rol. Los CLIs worker aún no aplican todos los niveles; la hoja queda como contrato alineado con pstack para cuando el adaptador lo soporte.

## Relación con pstack

- **pstack** en Cursor: la hoja alimenta `Task` / subagentes del orquestador.
- **zedpstack**: la misma hoja alimenta **spawn** de `claude`/`codex` en `.zedpstack/runs/`.

Mantén ambos en sync con `setup apply` tras cambiar la hoja.
