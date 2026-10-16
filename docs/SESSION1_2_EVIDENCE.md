# Session 1.2 — evidencia

## Coordinación (meta-zedpstack)

- Brief: `docs/AUDIT_REQUEST_1_2.md`
- Claude (explorer): `docs/audit-1.2-claude-plan.txt` — P2 en MH-Next → subtree; eventos filtrados; shellInvoked; cancel con SIGTERM.
- Codex (synthesizer): salida en `docs/audit-1.2-codex-plan.err` / plan — repo GitHub limpio + CI; omitir stream en events; shellInvoked synthesizer; cancel; guard text.

**Síntesis aplicada:** implementar P2 en el paquete `zedpstack/`, publicar repo `nndsk/zedpstack` con CI; eventos sin persistir `worker.output` por defecto; `signals.shellInvoked` en Codex; `dispatch cancel`; guard `result.text`; `.gitignore` de auditorías locales.

## Cambios

- `EventSink`: no persiste `worker.output`/`worker.stderr` salvo `--persist-stream-events`.
- `validation.mjs`: guard tipo `text`; synthesizer rechaza `shellInvoked`.
- `shellSignals.mjs` + Codex `result.signals`.
- `cancel.mjs` + CLI `cancel`; resume desde `cancelled`.
- `paths.mjs`: `ZEDPSTACK_ROOT` opcional + `dispatchScriptPath()`.
- CI: `.github/workflows/test.yml`.
- Versión `0.1.2`.

## Tests

`npm test` → **23/23**

## Post-auditoría Codex (cierre)

- `shellSignals`: líneas `exec` + `succeeded in Nms:` (formato real Codex).
- `run.mjs`: re-lee manifest; corta en `cancelled`; no sobrescribe tras cancel.
- Prompt synthesizer: prohibición explícita de shell.

## Pendiente

- Run fresco `architecture-review` post-1.2.
- Re-auditoría Codex GO tras fixes (opcional).
