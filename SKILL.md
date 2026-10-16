---
name: zedpstack
description: Orquestador portable multi-runtime (Claude/Codex workers + judgment humano/LLM). Usar con /zedpstack o @zedpstack para architecture-review y playbooks futuros.
disable-model-invocation: true
---

# zedpstack

> **The LLM decides; the dispatcher executes.**

Tú eres el **orquestador activo**. Esta skill define juicio; `scripts/dispatch.mjs` define mecánica.

## Cuándo invocar

- `/zedpstack` + objetivo → playbook por defecto `architecture-review` (sesión 1).
- No construyas comandos shell para workers.
- No interpoles prompts en `sh -c`.

## Flujo architecture-review

1. Ejecuta el dispatcher (desde la raíz del repo bajo revisión):

Con el paquete clonado o symlinked (`ln -sfn /ruta/zedpstack ~/.agents/skills/zedpstack`), el dispatcher resuelve playbooks y config vía `import.meta.url` (no hace falta exportar `ZEDPSTACK_ROOT` salvo override):

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs run \
  --playbook architecture-review \
  --goal "<objetivo en español>" \
  --repo "<ruta repo>" \
  --tee-events
```

2. Observa progreso en `workers/*/stdout.log` y eventos resumidos en `.zedpstack/runs/<runId>/events.jsonl` (`worker.output` no se persiste por defecto; `--tee-events` para stderr en vivo).
3. Cuando `manifest.status` sea `awaiting_judgment`, lee:
   - `workers/explore/result.json`
   - `workers/synthesize/result.json`
   - `JUDGMENT_INSTRUCTIONS.md` (instrucciones)
4. Escribe **judgment final** en `.zedpstack/runs/<runId>/orchestrator-judgment.md`.
5. Cierra el run:

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs judgment --run-id <runId> --repo <repo>
```

Cancelar un run en curso:

```bash
node ~/.agents/skills/zedpstack/scripts/dispatch.mjs cancel --run-id <runId> --repo <repo>
```

## Tu rol (judgment)

- Veredicto breve con evidencia citando rutas del repo.
- No modificar el repositorio bajo revisión durante workers; judgment es solo texto en el run dir.

## Configuración

- Copia `zedpstack.config.example.json` → `zedpstack.config.json` (gitignored).
- Modelos y timeouts son **machine-local**, no van al repo público.

## Resume

```bash
node .../dispatch.mjs resume --run-id <id> --repo <repo> --playbook architecture-review
```

Reutiliza pasos con `(playbook, stepId, stepIdentityHash, validResult)` solo tras revalidar `result.json`.

## Instalación Zed

```bash
ln -sfn /path/to/zedpstack ~/.agents/skills/zedpstack
```

## Límites sesión 1

Sin swarm, interrogate, DAG genérico, worktrees, tercer CLI, paralelismo, ni resume de sesiones nativas Claude/Codex.
