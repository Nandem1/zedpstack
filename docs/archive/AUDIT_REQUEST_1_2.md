# Auditoría / planificación — Session 1.2

Contexto: 1.1b cerrado (16 tests, fingerprint fuentes, resume sin bypass). Queremos Session 1.2 = hardening P2 + publicación `nndsk/zedpstack`, sin nuevos playbooks ni runtime.

## P2 inventariado (SESSION1_1_EVIDENCE)

1. Filtrar ruido stream-json en `events.jsonl` (miles de `worker.output`)
2. Codex read-only: validar ante `exec` / shell incidental en logs
3. `.gitignore` artefactos audit (`docs/audit-*.txt`, `*.err`, logs locales)
4. `ZEDPSTACK_ROOT` cuando la skill está symlinked (`~/.agents/skills/zedpstack`)
5. `dispatch cancel` + regresión resume si falta `result.json`
6. Guard `validation.mjs` si `result.text` no es string (evitar `.includes` en blocked phrases)
7. CI mínima (`npm test` en GitHub Actions)

## Decisiones que necesitamos (responde en español, ~500-700 palabras)

1. **Orden de entrega**: ¿repo GitHub primero (vacío + CI) y luego P2 en el mismo repo, o P2 en MH-Next y luego `git subtree`/copy?
2. **Eventos**: ¿omitir `worker.output`/`worker.stderr` en `events.jsonl` por defecto, tee opcional, o emitir solo eventos resumidos (`worker.stream.delta` con throttle)?
3. **Codex**: ¿fallar validación si stderr contiene patrones de shell (`succeeded in`, `package.json:` grep), o añadir `signals.shellInvoked` y fallar solo en read-only synthesizer?
4. **cancel**: ¿solo marca `manifest.status=cancelled` o también SIGTERM al PID activo si hay worker corriendo?
5. **ZEDPSTACK_ROOT**: ¿resolver en `dispatch.mjs` vía `import.meta.url` del paquete + export helper documentado en SKILL?
6. **GO/NO-GO**: lista priorizada máx. 5 ítems para 1.2 (no Session 2).

Lee solo `zedpstack/` (código + docs). No modifiques archivos.
