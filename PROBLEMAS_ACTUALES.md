# Problemas actuales

## El alias opus ejecutó Opus 4.8 cuando se esperaba Opus 5.5

Registrado el 17 de octubre de 2026. Estado abierto, con una mitigación temporal comprobada.

La consulta a Claude sobre el plan de v0.6.1 se despachó mediante el rol `judgment and prose`. Ese rol resolvió al modelo por defecto `opus` de pstack. El CLI instalado, Claude Code 2.1.195, resolvió el alias como `claude-opus-4-8`, aunque el modelo esperado era `claude-opus-5-5`.

La selección no fijó la versión y el orquestador no corrigió la diferencia al comprobar el registro. El primer dictamen correspondía a Opus 4.8 y no satisfacía la expectativa de una revisión con Opus 5.5.

La resolución del rol y del modelo explícito está en [src/workerModels.mjs](src/workerModels.mjs), en `resolveAgentModel`.

### Evidencia de la sesión

| Modelo solicitado | Claude Code | Resultado observado |
| --- | --- | --- |
| `opus`, por defecto del rol | 2.1.195 | El registro de inicio indicó `claude-opus-4-8`. La consulta terminó. |
| `claude-opus-5-5`, explícito | 2.1.195 | La API rechazó la consulta y exigió Claude Code 2.1.280 o posterior. |
| `claude-opus-5-5`, explícito | 2.1.280, instalación temporal | El registro de inicio indicó `claude-opus-5-5`. La consulta terminó. |

### Mitigación temporal

Se instaló Claude Code 2.1.280 en `/private/tmp` y se repitió la consulta con `--model claude:claude-opus-5-5`. Se verificó el modelo efectivo en el registro de inicio. Opus 5.5 respondió "Respaldo con condiciones" sobre el resumen del diagnóstico y el plan propuesto.

La instalación global permaneció en 2.1.195. La hoja de modelos y el código del proyecto no recibieron una corrección permanente. La repetición solo revisó el resumen, sin inspeccionar código ni evidencias privadas.

### Criterios de cierre pendientes

- La selección persistente del worker identifica Opus 5.5 explícitamente cuando ese es el modelo solicitado.
- El CLI utilizado es compatible con el modelo solicitado.
- El modelo efectivo se contrasta con el solicitado antes de atribuirle un dictamen. Una discrepancia o un rechazo queda registrado como una revisión pendiente.

Estos criterios describen trabajo pendiente. La mitigación temporal no cierra el problema.
