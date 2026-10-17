# Setup, orquestador y routing de modelos (zedpstack)

Estado: **borrador operativo** (2026-10-17). Cierra la ambigüedad “copiar la hoja de Cursor y romper workers”.

## Problema

- **pstack en Cursor** usa `~/.cursor/rules/pstack-models.mdc` para `Task` / subagentes (slugs como `composer-2.5`, `cursor-grok-*`).
- **zedpstack workers** hacen `spawn` de CLIs distintos: `claude`, `codex`, `agent` (Cursor).
- Un `setup apply` que prefería el `.mdc` de Cursor **copiaba slugs válidos en IDE** pero **inválidos en Claude CLI** (`model_not_found`).

## Decisiones

### D-01 — Dos hojas, una filosofía pstack

| Hoja | Ruta típica | Consumidor |
|------|-------------|------------|
| Orquestador | `~/.cursor/rules/pstack-models.mdc` | IDE / poteto-mode / ACP |
| Workers | `~/.zedpstack/pstack-models.md` | `dispatch setup apply` → `zedpstack.config.json` |

El orquestador **muestra** ambas con `dispatch setup diagnose` (o `plan`). El usuario **decide** qué escribir en la hoja de workers; no hay apply silencioso desde Cursor sin revisar.

### D-02 — Provider ≠ runtime

Cada binding en config lleva `runtime` explícito:

| `runtime` | CLI | Slugs típicos |
|-----------|-----|----------------|
| `claude` | `claude -p` | `haiku`, `sonnet`, `opus` |
| `codex` | `codex exec` | `gpt-*`, `*-sol` |
| `cursor` | `agent -p --mode plan` | `composer-*`, `cursor-grok-*`, `grok-*`, `glm-*` |

Clasificación central: `src/modelRouting.mjs`. `setup apply --strict` falla si slug y runtime no coinciden.

### D-03 — Orquestador agnóstico (Zed ACP)

Quién chatea (Cursor, Claude Code, Codex en Zed) **no** define cómo corren los workers.

- Detección best-effort: `detectOrchestratorHost()` + override `ZEDPSTACK_ORCHESTRATOR=cursor|claude-code|codex|zed`.
- Los workers siguen leyendo **solo** `zedpstack.config.json` + prompts pstack.

### D-04 — Progreso legible sin romper JSONL

- **Machine**: `events.jsonl` + `workers/*/stdout.log` (sin cambios de contrato).
- **Humano**: con TTY, `--tee-events` y `dispatch watch` emiten líneas tipo:
  - `Claude explorer — running (haiku)`
  - `> Inspecting src/...`
- Sin TTY: JSONL completo (`[zedpstack] {...}`).

Implementación: `src/progressUi.mjs`, `EventSink` con `humanProgress: auto`.

### D-05 — Consulta externa (Opus + Codex, 2026-10-17)

- **Opus**: exige validadores, no solo reglas “no copiar”; separar provider/runtime; `setup apply --dry-run` + diff; interfaz mínima entre runtimes.
- **Codex**: renderer sobre el mismo JSONL; actividad desde `tool_use` en stream-json; `dispatch watch` como consumidor natural.

## Comandos

```bash
# Ver estado (JSON)
node ~/Projects/zedpstack/scripts/dispatch.mjs setup diagnose

# Legible para el operador / orquestador
node ~/Projects/zedpstack/scripts/dispatch.mjs setup diagnose --human

# Aplicar solo hoja workers
node ~/Projects/zedpstack/scripts/dispatch.mjs setup apply --file ~/.zedpstack/pstack-models.md

# Vista previa sin escribir
node ~/Projects/zedpstack/scripts/dispatch.mjs setup apply --dry-run --file ~/.zedpstack/pstack-models.md

# Fallar si hay slug/runtime incompatible
node ~/Projects/zedpstack/scripts/dispatch.mjs setup apply --strict
```

## Pendiente

- [ ] `setup apply` interactivo en el orquestador (preguntas tipo pstack) — hoy `diagnose --human` + decisión del usuario.
- [ ] Mapeo automático “orquestador → propuesta worker sheet” con diff editable.
- [ ] Tests de integración `agent -p` en CI (opcional, requiere credenciales).
- [ ] Documentar slugs en `agent --list-models` como fuente viva para fila `cursor`.

## Referencias

- `setup-zedpstack/SKILL.md`
- `docs/PSTACK_ADAPTERS.md`
- `docs/STREAMING.md`
