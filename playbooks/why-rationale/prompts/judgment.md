# Judgment — pstack why

Lee `workers/investigate/result.json` y `workers/synthesize/result.json`. Escribe veredicto en `{{JUDGMENT_OUTPUT_FILE}}` citando tiers de confianza del synthesizer.

```bash
node {{ZEDPSTACK_ROOT}}/scripts/dispatch.mjs judgment --run-id {{RUN_ID}} --repo {{REPO_ROOT}}
```
