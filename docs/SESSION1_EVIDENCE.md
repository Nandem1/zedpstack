# Sesión 1 — evidencia

## Run real

- **runId:** `17e992f3-7bcb-4e22-a419-8d6c208ad589`
- **Repo:** MH-Next @ `0fe4a3d39885f7b523511b479f35242e28da4302`
- **Estado final:** `completed` (tras `judgment`)

Artefactos (gitignored en repo padre): `.zedpstack/runs/<runId>/`

## Criterios de aceptación

| # | Criterio | Evidencia |
|---|----------|-----------|
| 1 | runId creado | `manifest.json` + `events.jsonl` |
| 2 | Claude explorer lanzado | `worker.spawned` runtime `claude` |
| 3 | Output incremental | `worker.output` / `worker.stderr` en `events.jsonl` |
| 4 | Validación post-worker | `step.validated` / `step.completed` |
| 5 | Codex recibe refs | `synthesize` `inputFrom` explore `result.json` |
| 6 | Codex sintetiza | `workers/synthesize/result.json` |
| 7 | Judgment orquestador | `judgment.md` + `dispatch judgment` |
| 8 | Manifest completo | bindings, attempts, hashes, statuses |
| 9 | events.jsonl reconstruible | tipos `run.*`, `step.*`, `worker.*` |
| 10 | Fallo/resume | primer intento explore falló (`--verbose`); `resume` reintentó |
| 11 | Sin modificar repo (workers) | `git status` sin cambios atribuibles a workers |
| 12 | Sin prompt en shell | `spawn(argv[])` + `prompt.md` |
| 13 | Repo GitHub-ready | `zedpstack/` autocontenido, `LICENSE`, config example |

## Hallazgos sesión 1

- Claude `stream-json` requiere `--verbose`.
- Explorer debe usar `cwd=repoRoot` (corregido post-run).
- Codex `read-only` aún puede emitir `exec` en stderr; endurecer en sesión 2.
