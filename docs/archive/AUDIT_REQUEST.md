# Solicitud de auditoría — zedpstack sesión 1

Audita la implementación en el directorio `zedpstack/` (repo canónico embebido en MH-Next).

## Alcance

- `SKILL.md`, `scripts/dispatch.mjs`, `src/**`
- `playbooks/architecture-review/`
- `schemas/`, `tests/`
- `docs/SESSION1_EVIDENCE.md`, `docs/UPSTREAM.md`
- Contratos: RoleBinding, TaskSpec, manifest, events.jsonl, read-only security
- Run de evidencia: `.zedpstack/runs/17e992f3-7bcb-4e22-a419-8d6c208ad589/` (si accesible)

## Preguntas

1. ¿Cumple el principio "LLM decides; dispatcher executes" sin fugas (shell, prompts inline)?
2. ¿Huecos de seguridad o permisos (escalado, env, logs)?
3. ¿Manifest/events/resume coherentes con el diseño acordado?
4. ¿Qué falta para publicar en GitHub e instalar vía `~/.agents/skills/zedpstack`?
5. Top 5 issues priorizados (bug, security, design) con archivo:línea o ruta concreta.
6. Top 3 fortalezas.

Responde en **español**, ~600–900 palabras, sin proponer features fuera de sesión 1 salvo riesgos críticos.

No modifiques archivos.
