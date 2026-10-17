# Sesión 1.1 — evidencia (solo P1)

## Cambios por P1

| P1 | Cambio principal |
|----|------------------|
| Judgment | `JUDGMENT_INSTRUCTIONS.md` vs `orchestrator-judgment.md`; `validateOrchestratorJudgment` antes de `completed` |
| Resume | `canReuseCompletedStep` + `computeStepIdentity` (binding, prompt hash, inputs); sin `continue` ciego |
| Validación | `stages`, blocked phrases, señales `readSuccess`/`readDenied`, rol `explorer` |
| Claude RO | `--tools Read,Grep,Glob` + `--add-dir <repo>`; `workerEnv('claude')` acotado |

## Tests

`npm test` → **12/12** (incluye `resume-regression`, `judgment`, `validation-explorer`).

## Run de aceptación

- **runId:** `1f56f359-a8d0-4aad-a24f-15fa9c720f0a`
- Explorer: `signals.readSuccess: 3`, lecturas a `AGENTS.md`, plan ARQ, `src/shared/api/README.md` (stdout.log)
- Resume sin cambios: ~76 ms (`step.completed` con `reuse: true` en eventos)
- Run `completed`: resume posterior emite `skipped: already_completed` (sin pisar judgment)
- Judgment: archivos distintos; `dispatch judgment` exige veredicto válido

## P2 (no implementado — Session 1.2)

- Filtrar stream-json en `events.jsonl`
- `argv` vacío en eventos Claude (corregido en código actual: `argv` completo)
- Codex read-only aún ejecuta shell en algunos entornos
- `.gitignore` de artefactos audit en paquete
- Resolver `ZEDPSTACK_ROOT` en skill instalada por symlink
