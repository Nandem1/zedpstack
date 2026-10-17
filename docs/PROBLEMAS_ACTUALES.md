# Problemas actuales

## El alias opus ejecutó Opus 4.8 cuando se esperaba Opus 5.5

Registrado el 17 de octubre de 2026. Estado cerrado. La verificación de modelo, la hoja con ids concretos y el registro de mínimos de CLI en doctor quedaron implementados en el repositorio.

La consulta a Claude sobre el plan de v0.6.1 se despachó mediante el rol `judgment and prose`. Ese rol resolvió al modelo por defecto `opus` de pstack. El CLI instalado, Claude Code 2.1.195, resolvió el alias como `claude-opus-4-8`, aunque el modelo esperado era `claude-opus-5-5`.

La selección no fijó la versión y el orquestador no corrigió la diferencia al comprobar el registro. El primer dictamen correspondía a Opus 4.8 y no satisfacía la expectativa de una revisión con Opus 5.5.

La resolución del rol y del modelo explícito está en [src/workerModels.mjs](../src/workerModels.mjs), en `resolveAgentModel`.

### Evidencia de la sesión

| Modelo solicitado | Claude Code | Resultado observado |
| --- | --- | --- |
| `opus`, por defecto del rol | 2.1.195 | El registro de inicio indicó `claude-opus-4-8`. La consulta terminó. |
| `claude-opus-5-5`, explícito | 2.1.195 | La API rechazó la consulta y exigió Claude Code 2.1.280 o posterior. |
| `claude-opus-5-5`, explícito | 2.1.280, instalación temporal | El registro de inicio indicó `claude-opus-5-5`. La consulta terminó. |

### Mitigación temporal

Se instaló Claude Code 2.1.280 en `/private/tmp` y se repitió la consulta con `--model claude:claude-opus-5-5`. Se verificó el modelo efectivo en el registro de inicio. Opus 5.5 respondió "Respaldo con condiciones" sobre el resumen del diagnóstico y el plan propuesto.

La instalación global permaneció en 2.1.195. La hoja de modelos y el código del proyecto no recibieron una corrección permanente en ese momento. La repetición solo revisó el resumen, sin inspeccionar código ni evidencias privadas.

### Criterios de cierre

El corte 5 de [ACP_DESIGN.md](ACP_DESIGN.md) cierra el tercer criterio. Los tres criterios quedan cerrados en el código y en la documentación. El detalle está en «Verificación de modelo» de [ARCHITECTURE.md](ARCHITECTURE.md).

- **La selección persistente del worker identifica Opus 5.5 explícitamente cuando ese es el modelo solicitado.** Cerrado. La hoja acepta `claude-opus-5-5` y `spawnAgent` lo guarda como `expectedModel` ([src/agents/lifecycle.mjs](../src/agents/lifecycle.mjs)). `setup_plan` añade a cada alias que corre su id sondeado en `pin`, con una recomendación de fijarlo. `setup_write` escribe un alias tal cual y avisa del modelo que corre hoy ([src/setupWizard.mjs](../src/setupWizard.mjs)). La hoja del usuario fija `claude-opus-5-5` en el rol `strongest judgment` y en los cuatro paneles que usaban `opus`.
- **El CLI utilizado es compatible con el modelo solicitado.** Cerrado. Si la API exige un CLI más reciente, el error del worker nombra la versión instalada y la mínima que exige la API, por ejemplo `claude CLI 2.1.195 cannot run claude-opus-5-5: the API requires 2.1.280 or later`. La lógica está en `cliRejection` de [src/modelCheck.mjs](../src/modelCheck.mjs) y en `execAgent`. [src/cliCompat.mjs](../src/cliCompat.mjs) registra el mínimo por modelo concreto con evidencia, y `dispatch doctor` compara la versión instalada en `cliCompat` y añade el aviso a `problems` cuando el CLI queda por debajo. Las pruebas están en `tests/cli-compat.test.mjs`.
- **El modelo efectivo se contrasta con el solicitado antes de atribuirle un dictamen. Una discrepancia o un rechazo queda registrado como una revisión pendiente.** Cerrado en este corte. `loadAgent` deriva `modelCheck` (`ok`, `unverified` o `mismatch`) en [src/agents/store.mjs](../src/agents/store.mjs). `model_check` aparece en `agent_status`, `agent_result`, `wait_agent`, `list_agents`, el tablero y la tarjeta ACP. Un `mismatch` añade `warnings` al resultado y antepone el aviso a su texto, así que el orquestador lo lee antes del dictamen. Un rechazo deja el worker `failed` con el error descrito arriba. Las pruebas están en `tests/model-check.test.mjs`, el bloque «model check» de `tests/agent-store.test.mjs` y «worker card model check» de `tests/acp-updates.test.mjs`. El caso de 4.8 contra 5.5 da `mismatch`.

Los tres criterios de cierre quedan satisfechos en el repositorio.
