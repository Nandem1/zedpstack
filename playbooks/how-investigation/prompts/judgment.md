# Judgment (orquestador activo, pstack Investigation)

Workers ejecutaron el skill **how** de pstack (read-only). Lee:

- `workers/explore/result.json` (hallazgos explorer)
- `workers/synthesize/result.json` (explicación how)

Aplica criterio **unslop** al redactar. Escribe el juicio en **`{{JUDGMENT_OUTPUT_FILE}}`**:

## Veredicto

¿La explicación responde la pregunta con evidencia del repo?

## Evidencia

- 3 bullets con rutas citadas

## Siguiente paso

(Acción concreta si el operador debe cambiar código o profundizar)

```bash
node {{ZEDPSTACK_ROOT}}/scripts/dispatch.mjs judgment --run-id {{RUN_ID}} --repo {{REPO_ROOT}}
```
