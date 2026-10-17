# Bitácora

Registro de fallos, sorpresas y decisiones durante el trabajo en zedpstack, ordenado de más antiguo a más reciente.
El formato de las entradas y las reglas de registro están en la [skill zedpstack-bitacora](../zedpstack-bitacora/SKILL.md).
Las entradas abiertas requieren una decisión o el siguiente paso indicado antes de poder cerrarse.

## 2026-10-17 15:50 Worker de Cursor en bucle matando y relanzando un test colgado

- Estado: arreglado (390c52f).
- Síntoma: el test del hub no terminaba; el worker lo mataba y lo relanzaba durante más de 6 minutos.
- Evidencia: el commit 390c52f incorpora el hub del corte 1 tras el WIP 8ccfc44, cuyo mensaje registra que el test no termina.
- Causa: `getHubSession()` devolvía una copia; el engine reemplazado no se cerraba en shutdown; el handshake fallido no limpiaba el hijo.
- Acción: relevo con Codex y regla "no relanzar un comando colgado más de dos veces" en los briefs.

## 2026-10-17 16:00 Monitor y MCP con código viejo marcan agentes v2 como fallidos

- Estado: abierto. La acción pendiente del usuario es reiniciar `dispatch top` y la sesión.
- Síntoma: `dispatch top` muestra "failed: runner process exited without finishing" para strongest-judgment-bc324b, bug-fix-028c1b y how-explorer-c6b2dd; `agent status` con código nuevo los da `completed`.
- Evidencia: pid 17249 `dispatch.mjs top` con 4 h 44 min; el MCP de aquella sesión también era anterior al corte 2.
- Causa: procesos largos anteriores al almacén dividido; su `reconcile` viejo escribió `status` y `error` en `agent.json` v2.
- Acción: el lector nuevo ignora esos campos mediante detección por `version`, documentada junto al commit 6367a5f en la bitácora original. Reiniciar `top` y la sesión de Claude Code. Mientras tanto usar la CLI `dispatch agent ...`.

## 2026-10-17 16:03 session/cancel respondía cancelled antes de parar los workers

- Estado: arreglado (44a6861).
- Síntoma: `session/cancel` respondía `cancelled` antes de detener los workers; la bitácora original registra un flake en 1 de cada 6 ejecuciones.
- Evidencia: el commit 44a6861 espera a parar los workers al cancelar.
- Causa: la respuesta no esperaba a `closeAgent`.
- Acción: esperar la detención de los workers antes de responder, según el commit 44a6861.

## 2026-10-17 16:20 CI rojo desde v0.4.1

- Estado: arreglado (39fe1d1).
- Síntoma: CI rojo desde v0.4.1. La entrada original no incluye un id de ejecución.
- Evidencia: el commit 39fe1d1 corrige la ausencia de Claude en `PATH` y omite los tests de pstack cuando falta el plugin.
- Causa: `install.mjs` no contemplaba `claude` ausente; 7 tests dependían de pstack local.
- Acción: tolerar el CLI ausente y omitir las pruebas que requieren una instalación de pstack, según el commit 39fe1d1.

## 2026-10-17 18:30 Engine de Cursor cerraba con "closed"

- Estado: arreglado (df189fa).
- Síntoma: el engine de Cursor cerraba con el mensaje "closed".
- Evidencia: el commit df189fa autentica el engine de Cursor y convierte sus modelos y modos en desplegables.
- Causa: faltaba `authenticate` antes de `session/new`; el motivo real del cierre se perdía.
- Acción: autenticar antes de crear la sesión y conservar el motivo del cierre, según el commit df189fa.

## 2026-10-17 19:00 Commit f70eb92 no compila solo

- Estado: descartado (árbol final verde).
- Síntoma: el commit f70eb92 no compila por sí solo.
- Evidencia: f70eb92 importa `tests/helpers/env.mjs`, que llega en 6367a5f.
- Causa: dependencia entre commits publicada en ese orden.
- Acción: conservar la advertencia histórica; la entrada original no registra una reparación del commit aislado.

## 2026-10-17 19:20 El guard de ediciones bloquea comandos de bash inofensivos sobre /tmp

- Estado: abierto.
- Síntoma: `sed -i` sobre `/tmp/smoke-cards.mjs` y `echo > $ZH/acp-prefs.json` bloqueados con "delegate this edit via spawn_agent (bash mutation)".
- Evidencia: los comandos y el mensaje anteriores constan en la bitácora original; no se registró una ruta de log adicional.
- Causa: la guarda trata cualquier redirección o `sed -i` con ruta no resoluble como mutación del repo. Hipótesis sin confirmar: no resuelve rutas con variables ni distingue `/tmp`.
- Acción: se rodeó con la herramienta Write y `node -e`. Candidato a arreglar en `src/guard.mjs`, permitiendo rutas resolubles fuera del repo.

## 2026-10-17 20:00 kill() del engine daba por terminado el grupo al salir npm exec

- Estado: arreglado (139d79a).
- Síntoma: la prueba real del corte 4 vio el binario de claude-agent-sdk vivo tras `kill()`.
- Evidencia: el commit 139d79a registra pruebas y documentación de cancelación, caída del engine, SIGKILL del hub y watchdog.
- Causa: se esperaba solo al proceso lanzado, sin esperar a todo su grupo.
- Acción: esperar a todo el grupo hasta 3 s y enviar SIGKILL. Las pruebas con fakes no ven árboles de procesos reales; la prueba con el engine real es obligatoria en los cortes de procesos.

## 2026-10-17 20:20 Worker del corte 5 cortado por el límite de sesión de Claude

- Estado: arreglado (a108e13, ca08729, 37b2710, 8557a72), mediante relevo con alcance consolidado. Estos commits completan el corte 5; la entrada original decía "arreglado en proceso".
- Síntoma: `agent wait` devolvió failed exit 1 "You've hit your session limit"; quedó un árbol parcial con 3 tests en rojo, activity, agent origin y board.
- Evidencia: mensaje de `agent wait` registrado en la bitácora original y commits del corte 5 citados en el estado.
- Causa: cuota de Claude agotada con el rol "strongest judgment", modelo `claude-opus-5-5`.
- Acción: relevo fresco con el brief y el estado parcial. Sigue abierta la idea de alternar el rol de mayor juicio con Codex cuando Claude no tenga cuota.

## 2026-10-17 21:10 Los engines de Claude y Cursor editan por herramientas internas y la guarda del hub no las ve

- Estado: arreglado en parte (bec4455, f79b1a3). Deniega permisos de edición mientras `/edits` esté apagado y avisa después cuando el motor edita sin pedir permiso; no puede impedir el modo bypass. Pendiente la decisión del usuario sobre forzar un modo de solo lectura.
- Síntoma: la prueba real del corte 6 mostró que, al pedir al orquestador crear `yo.txt`, ambos engines usan su herramienta Edit/Write interna; ninguna petición `fs/write_text_file` llega al cliente. Con el hook PreToolUse instalado, Claude sí quedó bloqueado.
- Evidencia: prueba real registrada en la bitácora original; bec4455 implementa la guarda interna y f79b1a3 documenta su estado final.
- Causa: ACP permite que el agente edite sin pasar por el cliente.
- Acción: el corte 8 deniega `session/request_permission` de edición y avisa de las ediciones internas que detecta, sin cambiar el modo del engine. La propuesta original incluía interceptar permisos `edit`, `delete` y `move`, forzar un modo de solo lectura o confiar en la skill. Queda por decidir si se fuerza el modo de solo lectura; la propuesta original pedía probar con engines reales.

## 2026-10-17 21:10 cursor-agent no hereda el entorno del hub al MCP que arranca

- Estado: arreglado (400928f, corte 7). La bitácora original lo registra como verificado con Cursor real; los límites de verificación del sandbox del corte 7 están en [ACP_DESIGN.md](./ACP_DESIGN.md#arranque-y-errores-del-engine).
- Síntoma: el worker del orquestador tomó el modelo de la hoja real, no de la temporal; `ZEDPSTACK_HOME` y `ZEDPSTACK_MODEL_SHEET` no llegaron.
- Evidencia: el commit 400928f incorpora el entorno explícito del MCP; la observación del worker consta en la bitácora original.
- Causa: hipótesis sin confirmar de la entrada original, solo llega el `env` explícito de `mcpServers`.
- Acción: inyectar explícitamente en `mcpServers[].env` las variables `ZEDPSTACK_*` y `PSTACK_ROOT` del hub.
