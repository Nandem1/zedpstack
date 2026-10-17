# Problemas actuales

## El alias opus ejecutó Opus 4.8 cuando se esperaba Opus 5.5

Registrado el 17 de octubre de 2026. Estado abierto, con la verificación de modelo implementada y la hoja del usuario pendiente de fijar ids concretos.

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

### Criterios de cierre

El corte 5 de docs/ACP_DESIGN.md cierra el tercer criterio. Los dos primeros quedan cubiertos en el código, pero cada uno requiere todavía una acción del usuario. El detalle está en «Verificación de modelo» de docs/ARCHITECTURE.md.

- **La selección persistente del worker identifica Opus 5.5 explícitamente cuando ese es el modelo solicitado.** Cubierto en el código y pendiente en la hoja del usuario. La hoja acepta `claude-opus-5-5` y `spawnAgent` lo guarda como `expectedModel` ([src/agents/lifecycle.mjs](src/agents/lifecycle.mjs)). `setup_plan` añade a cada alias que corre su id sondeado en `pin`, con una recomendación de fijarlo. `setup_write` escribe un alias tal cual y avisa del modelo que corre hoy ([src/setupWizard.mjs](src/setupWizard.mjs)). Este corte no comprobó si `~/.zedpstack/pstack-models.md` ya fija `claude-opus-5-5` en los roles de juicio. Hay que ejecutar `/setup-zedpstack` y aceptar las recomendaciones.
- **El CLI utilizado es compatible con el modelo solicitado.** Cubierto para el diagnóstico y pendiente para la prevención. Si la API exige un CLI más reciente, el error del worker nombra la versión instalada y la mínima que exige la API, por ejemplo `claude CLI 2.1.195 cannot run claude-opus-5-5: the API requires 2.1.280 or later`. La lógica está en `cliRejection` de [src/modelCheck.mjs](src/modelCheck.mjs) y en `execAgent`. El repo no registra versiones mínimas, así que `doctor` no las compara. El 17 de octubre de 2026, el CLI instalado resolvió `opus` como `claude-opus-5-5`, según la caché de sondeos y un worker real.
- **El modelo efectivo se contrasta con el solicitado antes de atribuirle un dictamen. Una discrepancia o un rechazo queda registrado como una revisión pendiente.** Cerrado en este corte. `loadAgent` deriva `modelCheck` (`ok`, `unverified` o `mismatch`) en [src/agents/store.mjs](src/agents/store.mjs). `model_check` aparece en `agent_status`, `agent_result`, `wait_agent`, `list_agents`, el tablero y la tarjeta ACP. Un `mismatch` añade `warnings` al resultado y antepone el aviso a su texto, así que el orquestador lo lee antes del dictamen. Un rechazo deja el worker `failed` con el error descrito arriba. Las pruebas están en `tests/model-check.test.mjs`, el bloque «model check» de `tests/agent-store.test.mjs` y «worker card model check» de `tests/acp-updates.test.mjs`. El caso de 4.8 contra 5.5 da `mismatch`.

El problema sigue abierto hasta que la hoja del usuario fije los ids concretos.
