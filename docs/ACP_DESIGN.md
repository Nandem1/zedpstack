# Decisión de diseño: zedpstack ACP como anfitrión del orquestador

(Contenido que debe copiarse a docs/ACP_DESIGN.md, en español, sin cambios de fondo.)

## Estado
Aceptada el 2026-10-17 tras tres candidatos independientes (Codex gpt-6.1-sol, Claude opus-5-5, Cursor grok-4.7-high), síntesis del orquestador y verificación local.

## Problema
Zed debe ser el único sitio de trabajo: el hilo "zedpstack" es el orquestador. El usuario escribe `/claude`, `/codex` o `/cursor`, ajusta modelo/esfuerzo/permisos con los desplegables del pie del hilo y conversa con un LLM que corre poteto-mode. Los workers aparecen como tarjetas expandibles en vivo, los haya lanzado quien los haya lanzado. MCP sigue funcionando sin cambios para los hosts Claude/Codex/Cursor.

## Decisión
1. **Proxy ACP hacia un agente ACP hijo (un "engine") por sesión.** zedpstack no implementa un motor de conversación. Cada hilo de Zed tiene su propio proceso hijo con el agente ACP nativo del runtime elegido:
   - claude: `@agentclientprotocol/claude-agent-acp` (npx, versión fijada)
   - codex: `@agentclientprotocol/codex-acp` (npx, versión fijada)
   - cursor: `cursor-agent acp` (binario)
   Evidencia local: `~/Library/Application Support/Zed/external_agents/registry/registry.json` lista las tres distribuciones, y Zed ya las instala para el usuario. El engine se resuelve en este orden: override en `~/.zedpstack/config` (`acp.engines.<runtime>`), entrada del registro de Zed, y `npx -y <paquete>@<versión>` como último recurso.
2. **El hub solo interviene en cinco puntos**, todo lo demás pasa transparente (mensajes `session/update`, peticiones del hijo al cliente `fs/*`, `terminal/*`, `session/request_permission`, con remapeo de ids de sesión y de petición):
   1. `session/new`: inyecta el servidor MCP de zedpstack en `mcpServers` del hijo, con `ZEDPSTACK_ACP_SESSION`, `ZEDPSTACK_REPO` (y más adelante `ZEDPSTACK_ACP_BRIDGE`).
   2. Primer prompt de cada sesión de engine: antepone el cuerpo de la skill orquestadora (`orchestratorPrompt()`).
   3. Opciones y comandos: mezcla la opción `zp.runtime` y los comandos (`/claude`, `/codex`, `/cursor`, `/board`) con los `configOptions` y `available_commands_update` del hijo. Las opciones del hijo (modelo, esfuerzo, modo) se muestran tal cual, porque son la lista real de ese CLI. No se mantiene catálogo propio de modelos del orquestador.
   4. Tarjetas de workers: se superponen para todo agente cuyo `origin.sessionId` coincide con la sesión, reutilizando `createWorkerUpdateSink`.
   5. Política de cliente: peticiones `fs/write_text_file` y `terminal/create` del hijo pasan por la guarda de ediciones existente cuando el orquestador intentaría editar el repo.
3. **El almacén es la única fuente de verdad de la actividad.** El MCP del hijo llama a `spawnAgent`; el hub descubre el agente observando el directorio de agentes (fs.watch + sondeo) y lo sigue con el mismo `followAgent`. No hay canal push de actividad.
4. **Sin cerrojos entre procesos: un escritor por archivo** (separar antes de serializar). `agent.json` pasa a ser inmutable (spec). El runner escribe `run.json`, `stopAgent` crea `stop.json` con `wx`, `closeAgent` escribe `cleanup.json`. El estado se deriva al leer (`deriveStatus`); los lectores nunca escriben. Los registros v1 se leen con un adaptador heredado. Esto elimina las carreras de `updateAgent` y del reconcile.
5. **Verificación de modelo como contrato**, no como adorno: `expectedModel` en el spec, `effectiveModel` en `run.json`, `modelCheck` derivado (`ok`, `unverified`, `mismatch`). El alias `opus` no se ofrece como identidad: al escribir la hoja se fija el id concreto sondeado. Un `mismatch` queda visible en tarjeta, tablero y resultado, y el dictamen no se atribuye al modelo pedido. Cierra PROBLEMAS_ACTUALES.md.
6. **Cancelación y supervisión**: cada engine corre en su propio grupo de procesos (`detached`), `shutdown` envía SIGTERM y luego SIGKILL a los 3 s, y el hijo y el MCP vigilan el pid del padre. `session/cancel` se reenvía al hijo, aborta el turno y detiene solo los workers del turno (`origin.sessionId` y `createdAt` posterior al inicio del turno). Los workers de turnos anteriores siguen vivos, y los workers siguen desacoplados (D-03).
7. **Permisos de acciones de zedpstack** (`apply_agent_changes`, escritor con `isolation:none`, `close_agent` con borrado de rama): el MCP pregunta por un puente local y el hub emite `session/request_permission`. Fuera de ACP la pregunta se concede de inmediato (hosts MCP sin cambios). Timeout o cancelación equivalen a rechazo.

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

## Arranque y errores del engine

El handshake completo tiene un límite de 30 segundos. `initialize` incluye nombre y versión del cliente. Si el hijo anuncia métodos de autenticación, el engine espera `authenticate` antes de enviar `session/new`. Prefiere `cursor_login`. Para otros métodos, elige el primer id que no indique interacción, navegador, OAuth, dispositivo o login.

Un error o timeout termina el grupo del hijo y espera el cierre de sus pipes. El diagnóstico identifica la etapa, conserva el motivo RPC o el código o señal de salida y añade las últimas diez líneas de stderr, con un máximo de 8192 caracteres retenidos. Los errores de Cursor incluyen el hint «ejecuta `agent login`». El cierre explícito del peer acepta el motivo de terminación para que una petición pendiente no pierda ese dato bajo el mensaje genérico `closed`.

Una ruta relativa dentro de un archivo descargable del registro de Cursor no identifica un ejecutable instalado. Si el registro no incluye un directorio de instalación, el resolver usa `cursor-agent acp` desde `PATH`.

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
- ¿Los engines mandan ediciones y shell por `fs/write_text_file` y `terminal/create` del cliente, o las ejecutan internamente? Si es lo segundo, la guarda de protocolo no las ve y solo queda el hook PreToolUse existente.
- Los engines son dependencias externas que pueden cambiar: versiones fijadas, `doctor` informa del binario y la versión resueltos, y un incumplimiento marca el runtime como no disponible en vez de degradar en silencio.
- Cursor: comprobado el 2026-10-17 que `cursor-agent acp` acepta el `mcpServers` inyectado en `session/new` y llama a `spawn_agent` y `wait_agent` (también `claude-agent-acp@0.93.0`). Ambos piden `session/request_permission` por cada herramienta MCP.
- Codex y Cursor deben demostrar una fuente de evidencia del modelo efectivo; sin ella el estado es `unverified`, nunca `ok`. Para los workers la evidencia existe: el `init` de Cursor y la cabecera `model:` de Codex. Para el orquestador, el 2026-10-17 se capturaron todas las notificaciones de un turno trivial. `claude-agent-acp@0.93.0` envía `usage_update` con `_meta["_claude/model"]: "claude-sonnet-5-5"` (modelo `default`), y el hub lo usa. `cursor-agent acp` envía `session_info_update`, `agent_thought_chunk`, `agent_message_chunk` y `available_commands_update`, ninguno con el modelo, así que su orquestador queda `unverified`. `codex-acp` no pasó de `authenticate` porque pidió `CODEX_API_KEY` u `OPENAI_API_KEY`, así que queda sin comprobar y sin adaptador.
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
- [ ] Corte 6: permisos y guarda de ediciones.
- [ ] Corte 7: `/codex` y `/cursor` con preferencias.
- [ ] Corte 8: endurecimiento multihilo.
