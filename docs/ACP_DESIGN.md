# Decisión de diseño: zedpstack ACP como anfitrión del orquestador

## Estado
Aceptada el 2026-10-17 tras tres candidatos independientes (Codex gpt-6.1-sol, Claude opus-5-5, Cursor grok-4.7-high), síntesis del orquestador y verificación local.

## Problema
Zed debe ser el único sitio de trabajo: el hilo "zedpstack" es el orquestador. El usuario escribe `/claude`, `/codex` o `/cursor`, ajusta modelo/esfuerzo/permisos con los desplegables del pie del hilo y conversa con un LLM que corre poteto-mode. Los workers aparecen como tarjetas expandibles en vivo, los haya lanzado quien los haya lanzado. MCP sigue funcionando sin cambios para los hosts Claude/Codex/Cursor.

## Decisión
1. **Proxy ACP hacia un agente ACP hijo (un "engine") por sesión.** zedpstack no implementa un motor de conversación. Cada hilo de Zed tiene su propio proceso hijo con el agente ACP nativo del runtime elegido:
   - claude: `@agentclientprotocol/claude-agent-acp` (npx, versión fijada)
   - codex: `@agentclientprotocol/codex-acp` (npx, versión fijada)
   - cursor: `cursor-agent acp` (binario)
   Evidencia local: `~/Library/Application Support/Zed/external_agents/registry/registry.json` lista las tres distribuciones, y Zed ya las instala para el usuario. El engine se resuelve en este orden: override JSON argv en `ZEDPSTACK_ACP_ENGINE_<RUNTIME>`, override en `~/.zedpstack/config` (`acp.engines.<runtime>`), entrada del registro de Zed, y `npx -y <paquete>@<versión>` como último recurso. Cursor usa `cursor-agent acp` en `PATH` cuando el registro solo contiene una ruta relativa al archivo descargable.
2. **El hub solo interviene en cinco puntos**, todo lo demás pasa transparente (mensajes `session/update`, peticiones del hijo al cliente `fs/*`, `terminal/*`, `session/request_permission`, con remapeo de ids de sesión y de petición):
   1. `session/new`: inyecta el servidor MCP de zedpstack en `mcpServers` del hijo. Su `env` incluye `PATH`, `HOME` y todas las variables `ZEDPSTACK_*` y `PSTACK_*` del hub. Sobrescribe sesión, repo, puente y pid con los del hilo actual. No reenvía claves de proveedor ni secretos ajenos a esos prefijos.
   2. Primer prompt de cada sesión de engine: antepone el cuerpo de la skill orquestadora (`orchestratorPrompt()`).
   3. Opciones y comandos: mezcla la opción `zp.runtime` y los comandos (`/claude`, `/codex`, `/cursor`, `/board`) con los `configOptions` y `available_commands_update` del hijo. Las opciones del hijo (modelo, esfuerzo, modo) se muestran tal cual, porque son la lista real de ese CLI. No se mantiene catálogo propio de modelos del orquestador.
   4. Tarjetas de workers: se superponen para todo agente cuyo `origin.sessionId` coincide con la sesión, reutilizando `createWorkerUpdateSink`.
   5. Política de ediciones: peticiones `fs/write_text_file`, `terminal/create` y permisos internos de edición pasan por la guarda. Las ediciones internas notificadas sin permiso generan un aviso y un audit por llamada. `/edits on|off` cambia esta política por hilo, sin modificar el modo del engine.
3. **El almacén es la única fuente de verdad de la actividad.** El MCP del hijo llama a `spawnAgent`; el hub descubre el agente observando el directorio de agentes (fs.watch + sondeo) y lo sigue con el mismo `followAgent`. No hay canal push de actividad.
4. **Registros de agentes sin cerrojos entre procesos, con un escritor por archivo** (separar antes de serializar). `agent.json` pasa a ser inmutable (spec). El runner escribe `run.json`, `stopAgent` crea `stop.json` con `wx`, `closeAgent` escribe `cleanup.json`. El estado se deriva al leer (`deriveStatus`); los lectores nunca escriben. Los registros v1 se leen con un adaptador heredado. Esto elimina las carreras de `updateAgent` y del reconcile. El archivo compartido de preferencias usa una transacción con exclusión, descrita más abajo.
5. **Verificación de modelo como contrato**, no como adorno: `expectedModel` en el spec, `effectiveModel` en `run.json`, `modelCheck` derivado (`ok`, `unverified`, `mismatch`). El alias `opus` no se ofrece como identidad: al escribir la hoja se fija el id concreto sondeado. Un `mismatch` queda visible en tarjeta, tablero y resultado, y el dictamen no se atribuye al modelo pedido. Cierra PROBLEMAS_ACTUALES.md.
6. **Cancelación y supervisión**: cada engine corre en su propio grupo de procesos (`detached`), `shutdown` envía SIGTERM y luego SIGKILL a los 3 s, y el hijo y el MCP vigilan el pid del padre. `session/cancel` se reenvía al hijo, aborta el turno y detiene solo los workers del turno (`origin.sessionId` y `createdAt` posterior al inicio del turno). Los workers de turnos anteriores siguen vivos, y los workers siguen desacoplados (D-03).
7. **Permisos de acciones de zedpstack** (`apply_agent_changes`, escritor con `isolation:none`, `close_agent` que descarta trabajo no aplicado, `setup_write`): el MCP pregunta por un puente local y el hub emite `session/request_permission`. Fuera de ACP la pregunta se concede de inmediato (hosts MCP sin cambios). Timeout o cancelación equivalen a rechazo.

## Lo que se rechaza
- **Un proceso CLI headless por turno** (`claude -p --resume`, `codex exec`, `agent -p`) parseado a ACP: reimplementa tres veces tarjetas, diffs, pensamiento y permisos, exige listas de modelos a mano y pierde la UI nativa. Se conserva solo como idea de respaldo.
- **PTY interactivo por sesión**, **reimplementar poteto-mode dentro del proceso**, **llamar APIs de proveedor desde zedpstack**: fuera de alcance y contra docs/ARCHITECTURE.md.
- **Fachada `src/core`**: sería un pass-through; `src/agents/lifecycle.mjs` ya es el núcleo compartido.
- **Cerrojos entre procesos sobre `agent.json`**: se evita con un escritor por archivo.
- **Un shim ACP propio para Cursor**: innecesario, `cursor-agent acp` existe.
- **Un engine compartido para todos los hilos**: una caída mataría todos los hilos.

## Mapa de módulos
| Módulo | Responsabilidad |
|---|---|
| `src/agents/store.mjs` | Archivos por actor, `deriveStatus`, adaptador v1, `loadAgent`, `createSpec`, `writeRun`, `markStop`, `markCleanup` |
| `src/agents/lifecycle.mjs` | API actual sin romper; añade `origin` y `expectedModel`; lecturas vía `loadAgent` |
| `src/modelCheck.mjs` | `expectedModelFor`, `checkModel` |
| `src/acp/rpc.mjs` | Par JSON-RPC bidireccional por líneas (peticiones en ambos sentidos, correlación de respuestas). El spike descarta las respuestas del cliente |
| `src/acp/engine.mjs` | Resolución del comando del hijo, arranque en grupo propio, `initialize`, autenticación, `session/new`, timeout y diagnóstico del arranque, kill |
| `src/acp/hub.mjs` | Tabla de sesiones, los cinco puntos de intervención, turno/cancel, shutdown |
| `src/acp/options.mjs` | Mezcla de `zp.runtime` con las opciones del hijo, enrutado por id, comandos, preferencias en `~/.zedpstack/acp-prefs.json` |
| `src/acp/cards.mjs` | Observador del almacén (sondeo), filtro por origen, un sink por agente; `follow.mjs` queda como primitiva de seguimiento de un agente y solo la usa `cards.mjs` |
| `src/orchestratorPrompt.mjs` | Cuerpo de SKILL.md compartido por el prompt MCP `/zedpstack` y el prefijo del primer prompt del hub |
| `src/acp/bridge.mjs` | Socket Unix para permisos de acciones de zedpstack |
| `src/acp/editGuard.mjs` | Permisos de herramientas internas, unión de updates por id, avisos y estado de `/edits` |
| `src/acp/updates.mjs`, `commands.mjs` | Se reutilizan; `/spawn` y el turno del spike (`server.mjs`) ya no existen: los workers los lanza el engine por MCP |
| `src/mcp/*` | Sin cambio de protocolo; lee `origin` del entorno y usa `askHuman` |

## Datos
- `AgentSpec` (agent.json, escrito una vez con `wx`): id, binding, rol, descripción, cwd, repoRoot, isolation, worktree, timeoutMs, `origin {frontend, sessionId, pid}`, `expectedModel`.
- `RunState` (run.json, solo el runner, tmp+rename): runnerPid, workerPid, startedAt, effectiveModel, outcome.
- `LaunchMark` (launch.json, `{runnerPid}`, solo `spawnAgent`, una vez).
- `StopMark` (stop.json, `wx`), `CleanupMark` (cleanup.json).
- `AgentView` fusionado al leer: `{spec, run, launch, stop, cleanup, status, error, finishedAt, modelCheck}`.
- `HubSession`: id, cwd, runtime, engine, primed, turn, cards, opciones y comandos del hijo.

## Opciones de configuración (ACP v1)
`configOptions` en la respuesta de `session/new`, `session/set_config_option` y `config_option_update` con la lista completa. `/claude` equivale a elegir el runtime en el desplegable: si cambia, se mata el engine, se arranca el nuevo, se reaplican las elecciones guardadas de ese runtime y se emite `config_option_update`. Cambiar de runtime reinicia la conversación (se avisa en el hilo). Al abrir el hilo se arranca el engine del último runtime usado.

Si el hijo no devuelve `configOptions`, el hub deriva `model` desde `models` y `mode` desde `modes`. Conserva los ids completos del hijo, incluidos parámetros como `[effort=high,fast=true]`, y devuelve los campos legacy sin modificarlos en `session/new`. `zp.runtime` precede a las opciones del hijo. Una lista nativa de `configOptions`, incluso vacía, tiene prioridad sobre los campos legacy.

El estado interno de opciones contiene `{configOptions, legacyRoutes}`. Las rutas existen solo para opciones derivadas. `model` usa `session/set_model` con `modelId` y `mode` usa `session/set_mode` con `modeId`. Las opciones nativas usan `session/set_config_option`. El cambio directo y la reaplicación de preferencias comparten esta selección de método. Las actualizaciones legacy `current_mode_update` y `current_model_update` modifican la opción derivada y generan un `config_option_update` con la lista completa.

Cada sesión tiene una cola de cambios de configuración. El hub espera hasta `setImmediate` para agrupar las peticiones consecutivas de Zed y selecciona primero los cambios `zp.runtime` pendientes. Mantiene el orden de llegada entre cambios de runtime y entre las demás opciones. Una petición ya enviada al engine termina antes de ejecutar la siguiente.

Antes de enviar o guardar un valor, el hub lo valida contra las opciones vivas. Admite listas planas, grupos de opciones y opciones booleanas. Un valor inválido o un id desconocido devuelve error JSON-RPC `-32602` con los valores disponibles y no modifica opciones ni preferencias. Las preferencias se guardan en `perRuntime.<runtime>`. Al reaplicarlas, los valores obsoletos se eliminan del archivo y se registran una vez en stderr, sin mensaje en el hilo. Un fallo RPC transitorio conserva una preferencia válida. La validación se repite después de cada respuesta, porque cambiar de modelo puede cambiar otras opciones.

Las escrituras de preferencias son transacciones por clave. `updatePrefs` serializa procesos mediante un directorio exclusivo con marcador de PID, lee el documento vigente y publica un temporal con rename. Retira marcadores de propietarios muertos y limita la espera a 5 s. La eliminación de un valor obsoleto compara dentro de la transacción el valor que leyó el engine. Dos sesiones o hubs no sobrescriben las elecciones de otro runtime.

## Ediciones internas y modo del engine

Con `/edits off`, el hub rechaza localmente `session/request_permission` de tipo `edit`, `delete` o `move`. Para `execute` reutiliza la heurística `editVerdict` de shell. Elige `reject_once`, después `reject_always`, por el `kind` anunciado, o responde `cancelled`. No presenta esa pregunta en Zed. Escribe una sola vez por llamada el mensaje de delegación y una línea en `.zedpstack/orchestrator-audit.jsonl`. Con `/edits on`, las solicitudes pasan intactas a Zed.

Un registro por engine une `tool_call` y `tool_call_update` parciales por id. Cuando una edición interna apunta al cwd, fuera de `.zedpstack/`, emite un aviso y un audit por llamada. Excluye ids `zp-` de workers y permisos propios, y llamadas que ya rechazó. El aviso se basa en la notificación del engine y no revierte archivos. Un engine que omita ubicaciones y diffs puede editar sin que el hub lo detecte.

`/edits` muestra `editsAllowed`, el modo actual y la aplicación con el interruptor apagado. Ninguna capa cambia el modo elegido por el usuario.

| Runtime | Modo | Nivel con `/edits off` |
|---|---|---|
| Claude | `default`, `plan` | bloquea permisos de edición |
| Claude | `acceptEdits`, `bypassPermissions`, otros | solo avisa |
| Cursor | `ask`, `plan` | bloquea permisos de edición |
| Cursor | `agent`, otros | solo avisa |
| Cualquiera | Desconocido | solo avisa y rechaza permisos de edición si llegan |

El estado menciona `dispatch install` para instalar el hook PreToolUse de Claude Code. Ese hook usa el marcador del repo y es independiente de `/edits`. Las acciones MCP de zedpstack siempre mantienen sus propias preguntas.

### Orquestador Cursor y workers por rol

El flujo con Cursor y `grok-4.6` como orquestador usa el desplegable de modelos del propio engine, sin catálogo de zedpstack. Elige `/cursor` y después `grok-4.6` si el CLI lo anuncia. La selección se guarda solamente para Cursor. La hoja de workers puede asignar `how explorer` a `claude:claude-haiku-5-5` y `bug-fix` a `codex:gpt-6.1-sol`.

Registra el hub como agente custom en `settings.json` de Zed:

```json
{
	"agent_servers": {
		"zedpstack": {
			"type": "custom",
			"command": "/usr/local/bin/node",
			"args": ["/ruta/zedpstack/scripts/acp.mjs"],
			"env": { "ZEDPSTACK_MODEL_SHEET": "/ruta/worker-models.md" }
		}
	}
}
```

Omite `default_config_options` o incluye solamente valores válidos en todos los runtimes utilizados. Zed los aplica después de `session/new`; un valor como `mode=bypassPermissions` de Claude se rechaza en Cursor. Para elegir solo el runtime inicial puedes usar `"default_config_options": {"zp.runtime": "cursor"}` dentro de `agent_servers.zedpstack`. Las elecciones específicas de modelo y modo quedan en las preferencias del hub.

## Arranque y errores del engine

El handshake completo tiene un límite de 30 segundos. `initialize` incluye nombre y versión del cliente. Si el hijo anuncia métodos de autenticación, el engine espera `authenticate` antes de enviar `session/new`. `src/acp/auth.mjs` contiene la política explícita, en este orden:

| Runtime | Método | Condición | Acción si falla |
|---|---|---|---|
| Claude | `claude-login` | Lo anuncia el engine; usa las credenciales del CLI | `claude auth login` o `ANTHROPIC_API_KEY` |
| Codex | `chat-gpt` | Lo anuncia el engine; comprueba primero el login guardado | `codex login` |
| Codex | `api-key` | Lo anuncia el engine y existe `CODEX_API_KEY` u `OPENAI_API_KEY` no vacía en el hub | Configurar la clave en el entorno del hub |
| Cursor | `cursor_login` | Lo anuncia el engine; usa el login existente | `agent login` |

No hay elección por heurística ni fallback a métodos desconocidos. Si ninguno cumple la política, el error enumera ids y nombres disponibles y da el comando de login o la variable necesaria. El método elegido se registra en stderr. No se reintenta con otra fuente de autenticación tras un rechazo.

Verificado el 2026-10-17 con `codex-acp@2.2.2` real. `initialize` anunció `api-key`, con `_meta["api-key"].provider="openai"`, y `chat-gpt`. La capa engine eligió `chat-gpt` sin claves API y obtuvo `session/new` con opciones nativas de modelo, esfuerzo, modo, colaboración y fast mode. Con el `CODEX_HOME` original el app-server terminó con «Operation not permitted» en el sandbox. La prueba usó un directorio temporal escribible con una copia del login existente, borrada después. Cursor real anunció `cursor_login`, pero respondió «Login failed or timed out» en `authenticate` dentro del sandbox. La causa de ese rechazo no quedó determinada. No se pudo verificar allí un worker real de Cursor a través del MCP; la prueba con engine falso cubre la hoja temporal y un MCP sin entorno heredado.

Un error o timeout termina el grupo del hijo y espera el cierre de sus pipes. El diagnóstico identifica la etapa, conserva el motivo RPC o el código o señal de salida y añade las últimas diez líneas de stderr, con un máximo de 8192 caracteres retenidos. Los errores de Cursor incluyen el hint «ejecuta `agent login`». El cierre explícito del peer acepta el motivo de terminación para que una petición pendiente no pierda ese dato bajo el mensaje genérico `closed`.

Una ruta relativa dentro de un archivo descargable del registro de Cursor no identifica un ejecutable instalado. Si el registro no incluye un directorio de instalación, el resolver usa `cursor-agent acp` desde `PATH`.

`dispatch doctor --human` y `--json` comparten el resolver con `startEngine`. La sección ACP muestra origen (`env`, `user-config`, `zed-registry`, `npx-pin` o `path`), comando, versión declarada, ejecutable, caché npx y política de autenticación. Solo lee archivos locales. Un ejecutable ausente, sin permiso de ejecución, o un paquete npx sin la versión resuelta completa se marca como no instalado, también en la descripción de `zp.runtime`. Encontrar el paquete en caché no garantiza que los metadatos de npm permitan ejecutar `npx --offline`, ni comprueba el login.

## Plan de cortes (cada uno termina en una comprobación)
1. `/claude` + desplegables + turno de conversación en streaming (rpc, engine, hub passthrough, fixture de agente ACP falso).
2. Almacén dividido, estado derivado y `origin`.
3. Inyección del MCP, skill en el primer prompt y tarjetas por observación del almacén.
4. Cancelación y supervisión.
5. Verificación de modelo.
6. Permisos y guarda de ediciones.
7. `/codex` y `/cursor`, preferencias y reaplicación.
8. Endurecimiento multihilo.

## Riesgos y preguntas abiertas
- ¿Zed renderiza `tool_call` / `tool_call_update` emitidos por el hub fuera de un `session/prompt` abierto? Si no, `cards.resync()` al inicio de cada turno lo cubre.
- Los engines reales de Claude y Cursor escriben internamente, comprobado el 2026-10-17. El corte 8 bloquea sus permisos de edición y avisa por notificaciones. Un modo que omite permisos permite escribir antes del aviso. Sin ubicaciones ni diffs, el hub tampoco puede detectarlo. Claude mantiene además el hook PreToolUse con `dispatch install`; no hay hook equivalente de Cursor.
- Los engines son dependencias externas que pueden cambiar: versiones fijadas, `doctor` informa del binario y la versión resueltos, y un incumplimiento marca el runtime como no disponible en vez de degradar en silencio.
- Cursor: comprobado el 2026-10-17 que `cursor-agent acp` acepta el `mcpServers` inyectado en `session/new` y llama a `spawn_agent` y `wait_agent` (también `claude-agent-acp@0.93.0`). Ambos piden `session/request_permission` por cada herramienta MCP.
- Codex y Cursor deben demostrar una fuente de evidencia del modelo efectivo; sin ella el estado es `unverified`, nunca `ok`. Para los workers la evidencia existe: el `init` de Cursor y la cabecera `model:` de Codex. Para el orquestador, el 2026-10-17 se capturaron todas las notificaciones de un turno trivial. `claude-agent-acp@0.93.0` envía `usage_update` con `_meta["_claude/model"]: "claude-sonnet-5-5"` (modelo `default`), y el hub lo usa. `cursor-agent acp` envía `session_info_update`, `agent_thought_chunk`, `agent_message_chunk` y `available_commands_update`, ninguno con el modelo, así que su orquestador queda `unverified`. `codex-acp@2.2.2` ya pasó `authenticate` y `session/new` con el login existente en el corte 7; no se ejecutó un turno para verificar su modelo efectivo y sigue sin adaptador.
- La decisión 5 decía que al escribir la hoja se fija el id sondeado. El corte 5 no reescribe en silencio: `setup_write` escribe el alias que se le pide y avisa del modelo que corre hoy, y `setup_plan` recomienda fijarlo.
- Cambiar de runtime reinicia la conversación; se acepta a cambio de no inventar continuidad propia.
- `session/close` es inestable en ACP. El hub lo anuncia (`sessionCapabilities.close`) y lo atiende, pero si Zed cierra un hilo sin avisar, la sesión vive hasta el cierre del hub. El tope de engines limita el coste.
- Un engine de terceros que no vigila `ZEDPSTACK_PARENT_PID` depende de terminar con el EOF de stdin cuando el hub muere por SIGKILL. `claude-agent-acp@0.93.0` lo cumple: el grupo desapareció 3 s después del SIGKILL (2026-10-17).

## Estado de implementación

- [x] Corte 1: `/claude` + desplegables + conversación en streaming vía engine hijo ACP (`rpc.mjs`, `engine.mjs`, `hub.mjs`, `options.mjs`, agente falso, pruebas).
- [x] Corte 2: almacén dividido y `origin` (`store.mjs` con un escritor por archivo, `deriveStatus`, adaptador v1, `origin` por frontend; pruebas de carrera stop/runner en proceso y entre procesos).
- [x] Corte 3: MCP, skill en primer prompt, tarjetas por almacén (`engineMcpServers`, `orchestratorPrompt.mjs`, `cards.mjs`; `/spawn` y `server.mjs` eliminados; verificado con engines reales Claude y Cursor).
- [x] Corte 4: cancelación y supervisión (turno con `cancelling` compartido, workers del turno detenidos antes de responder `cancelled`, permisos pendientes cancelados, caída del engine con `refusal` y reinicio perezoso, `session/close`, tope `ZEDPSTACK_ACP_MAX_ENGINES`, vigilancia de `ZEDPSTACK_PARENT_PID` en el engine y el MCP; verificado con el engine real de Claude). Ver «Cancelación y supervisión» en docs/ARCHITECTURE.md.
- [x] Corte 5: verificación de modelo (`modelCheck.mjs` con `normalizeModelId`, `expectedModelFor` y `checkModel`; `expectedModel` en el spec, `modelCheck` derivado al leer y `model_check` en todas las salidas; aviso en tablero, tarjeta y resultado; error de CLI antiguo con la versión instalada; `setup_plan` recomienda fijar ids y `setup_write` avisa al escribir un alias; aviso del orquestador Claude por `usage_update`). Verificado con workers reales de Cursor y Claude y con los engines reales de Claude y Cursor. Ver «Verificación de modelo» en docs/ARCHITECTURE.md.
- [x] Corte 6: permisos y guarda de ediciones (`bridge.mjs` con socket Unix 0600 por hub, `askHuman` que concede sin puente y falla cerrado con él; `session/request_permission` con `allow_once`, `allow_always` por hilo y acción y `reject_once`; rechazo de preguntas pendientes al cancelar, cerrar, reiniciar o perder el engine y apagar el hub; `apply_agent_changes`, `spawn_agent` en el checkout, `close_agent` que descarta trabajo y `setup_write` preguntan; guarda `fs/write_text_file` y `terminal/create` con `editVerdict` y `/edits on|off`). Verificado con el engine real de Cursor (rechazo y permiso de `apply_agent_changes`) y con los de Claude y Cursor para las ediciones directas. Ver «Permisos y guarda de ediciones» en docs/ARCHITECTURE.md.
- [x] Corte 7: autenticación explícita por runtime, login existente de Codex, entorno MCP por prefijos, validación y cola de opciones con prioridad de runtime, preferencias independientes y limpieza de valores obsoletos, diagnóstico ACP local compartido y flujo Cursor `grok-4.6` con workers por rol. Codex real verificado hasta `session/new`; Cursor real solo hasta `initialize` por rechazo de autenticación en este entorno. La prueba del MCP sin entorno heredado usa el engine falso.
- [x] Corte 8: permisos de herramientas internas, avisos por llamada y estado honesto de `/edits`; preferencias atómicas con transacción por clave; admisión de engines serializada, cierre que espera arranques, limpieza de hijos tras caída y retiro de timers. Pruebas con cuatro hilos sobre uno y dos repos, dos procesos de hub y 50 ciclos de apertura y cierre. La verificación del puente y de engines reales depende de los permisos del entorno.

Los ocho cortes están implementados. Permanecen abiertos estos límites:

- Los modos que omiten preguntas permiten ediciones internas. El aviso depende de las ubicaciones o diffs publicados y la detección de shell es heurística.
- Cursor y Codex no tienen evidencia adaptada del modelo efectivo del orquestador. Quedan `unverified`.
- Cambiar de runtime pierde la conversación. No hay `session/load`.
- Sin `session/close` de Zed, la sesión dura hasta la evicción o shutdown. Un SIGKILL del hub depende del EOF o la supervisión del engine externo.
- El renderizado de tarjetas fuera de un turno depende de Zed; `cards.resync()` al inicio de cada prompt recupera su estado.
- Las pruebas que requieren sockets Unix y credenciales o red no pueden darse por verificadas en un sandbox que los prohíbe. El corte 8 conserva esas pruebas para ejecutarlas fuera de ese entorno.

La verificación final del corte 8 en este sandbox aprobó 316 pruebas sin las suites que requieren el puente de permisos, tanto sin variables de origen como con las tres heredadas. Con HOME vacío aprobó 309 y omitió 7 pruebas que requieren una instalación local de pstack. Los intentos completos de `npm test` encontraron `listen EPERM` y una regresión de limpieza corregida después, cuya prueba ya pasa con el engine falso. Las suites completas y el puente entre hubs quedan pendientes de validación fuera del sandbox. Cursor real anunció `cursor_login` y rechazó `authenticate` con "Login failed or timed out". No se ejecutó el prompt de escritura en `agent`, `ask` ni `plan`.

## Material de apoyo

El [índice ACP](./acp/README.md) reúne el rastro de implementación, los briefs originales y los tres candidatos de arquitectura. Conserva el contexto histórico; las decisiones vigentes y los límites están en este documento.
