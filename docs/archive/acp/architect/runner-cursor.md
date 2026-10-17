# Candidato de arquitectura de Cursor

Modelo: grok-4.7-high
Runtime: cursor
Fecha: 2026-10-17

Candidato de diseño del corte de arquitectura; la decisión final está en docs/ACP_DESIGN.md

Voy a leer la skill de architect y el brief antes de armar el diseño.El brief pide un diseño completo. Voy a leer el núcleo, el spike ACP y el esquema ACP v1 para anclar las firmas.# Diseño candidato: un turno de CLI headless por mensaje

El hilo de Zed habla con un orquestador que es `claude -p`, `codex exec` o `agent -p` lanzado **una vez por turno**, con `--resume` (o el equivalente del runtime) como memoria, el MCP de zedpstack inyectado por un config efímero, y las tarjetas de workers saliendo del directorio de agentes. El proxy ACP↔ACP queda descartado. No hay fachada `src/core`.

Supuestos que uso porque nadie puede confirmarlos a mitad de camino: el esquema ACP v1 de opciones es camelCase (`configOptions`, `session/set_config_option`, `config_option_update`, `type: "select"`, `currentValue`, `options[].value/name`), alineado con el spike (`sessionUpdate`, `availableCommands` en `src/acp/server.mjs:192-198`) y con los nombres del brief. La descarga del esquema en agentclientprotocol.com fue rechazada; si Zed esperara snake_case, el cambio vive solo en `src/acp/updates.mjs`. Los flags exactos `--resume`, `--mcp-config` y `--strict-mcp-config`, y el sobre de permiso de Claude, se confirman contra el `--help` del CLI en el slice que los usa; no entran en tipos compartidos.

## Problem

Zed tiene que ser el único sitio donde corre poteto-mode, eligiendo runtime con `/claude`, `/codex` o `/cursor` y modelo, esfuerzo y permiso en los desplegables del pie. El spike ACP (`src/acp/server.mjs:105-151`, `src/acp/commands.mjs:12-18`) solo parsea `/spawn` y `/board` y dibuja una tarjeta por worker. No hay sesión de LLM.

El routing sigue siendo de pstack. `docs/ARCHITECTURE.md:9-21` fija que zedpstack es el `Agent` portable, no un segundo orquestador. El MCP (`src/mcp/server.mjs`, `src/mcp/tools.mjs`) tiene que seguir igual para Claude, Codex y Cursor.

El proceso ACP es uno solo para varios hilos (`createSessionStore` en `src/acp/server.mjs:28-44`). Quien hace `spawn_agent` es un hijo MCP, no el proceso ACP, y Zed no manda `progressToken` (`docs/ACP_SPIKE.md:60`). La actividad de workers ya se descubre leyendo disco (`src/acp/follow.mjs:39-68`). `agent.json` se reescribe entero sin candado (`src/agents/store.mjs:44-66`); `updateAgent` solo lo llama `src/agents/lifecycle.mjs`. El alias `opus` se guardó como efectivo distinto y nadie comparó (`PROBLEMAS_ACTUALES.md:1-32`, `src/runtimes/activity.mjs:47`, `src/agents/lifecycle.mjs:201`). `src/manifestLock.mjs:1-16` es un mutex dentro del proceso: no sirve entre ACP, MCP y el runner.

## Usage (caller's view)

En Zed, `agent_servers.zedpstack` sigue siendo `node scripts/acp.mjs`. El usuario abre un hilo sobre el repo. El pie muestra el último runtime guardado en `~/.zedpstack/acp-preferences.json` (si no hay, el primer CLI de `claude`, `codex`, `cursor` que responda `--version`). Escribe `/claude`. El hilo confirma el runtime y el pie pasa a tres selects: modelo, esfuerzo, permiso. Escribe la tarea. El texto del asistente llega como `agent_message_chunk`. Si el modelo llama a `spawn_agent`, aparece una tarjeta `kind: "other"` con id `zp-<agentId>`, la misma del spike. `/codex` y `/cursor` cambian el catálogo. `/board` lista el tablero. `/spawn` deja de anunciarse en el mismo cambio que enciende las tarjetas del orquestador.

Sitio 1, el prompt de Zed (el contrato externo):

```json
{ "method": "session/prompt", "params": { "sessionId": "sess-…", "prompt": [{ "type": "text", "text": "arregla el fallo de resume" }] } }
```

Respuesta: `{ "stopReason": "end_turn" }` o `"cancelled"`. Mientras, notificaciones `agent_message_chunk` y `tool_call` / `tool_call_update`. Un segundo prompt con el turno aún activo recibe error JSON-RPC `-32602` y el texto `turn in progress`.

Sitio 2, el cambio de modelo, también desde Zed:

```json
{ "method": "session/set_config_option", "params": { "sessionId": "sess-…", "configId": "model", "value": "claude-opus-5-5" } }
```

La respuesta trae la lista nueva de `configOptions`. El proceso del turno en curso no se toca; el argv del turno siguiente usa el valor. Un `value` que no está en el catálogo se rechaza y el archivo de preferencias no cambia.

Sitio 3, el test sin CLI real. El único punto de inyección es `spawn`:

```js
import { runOrchestratorTurn } from '../src/acp/orchestrator.mjs';

await runOrchestratorTurn({
  session,
  text: 'hola',
  signal: controller.signal,
  notify,
  requestClient,
  spawn: fakeSpawn,
});
```

`fakeSpawn` escribe un `system/init` con `model` y `session_id`, luego deltas `assistant`, y cierra. El test afirma los chunks y que `session.resumeId` quedó guardado. Los bins de `tests/fixtures/bin/` siguen siendo de los workers, no de este turno.

## Shape

### Decisiones que cargan el diseño

Un turno, un proceso CLI, una función pública: `runOrchestratorTurn`. La continuidad es el id de resume guardado en la sesión en memoria. `loadSession` sigue en `false` (`src/acp/server.mjs:92`). Si Zed mata el proceso, el hilo nuevo no rehidrata la transcripción; sí rehidrata modelo y permiso desde las preferencias.

El primer turno de una sesión manda por stdin el cuerpo de `orchestratorPrompt()` (`src/mcp/server.mjs:32-36`) más el texto del usuario. Los turnos con `resumeId` mandan solo el texto nuevo. El preámbulo tiene un solo autor.

`spawn_agent` no lanza al orquestador. Los argv de worker (`src/permissions.mjs:82-162`) no ganan flags de resume ni de MCP. El orquestador tiene su propio adaptador.

Las tarjetas de workers salen de un solo sitio: un poll del directorio de agentes durante el turno, filtrado por `owner.sessionId`. Los `tool_use` cuyo nombre es una herramienta de `TOOLS` (`src/mcp/tools.mjs:40-199`) no se dibujan. Read, Bash y el resto del CLI sí pueden ser tarjetas `orch-<n>`, con otro prefijo de id. Así hay una manera de ver un worker y otra de ver una herramienta del host.

El runtime se elige solo con `/claude`, `/codex`, `/cursor`. No hay select de runtime ni `session/set_mode`. El permiso del orquestador es un select, no un mode: son tres controles de pie (modelo, esfuerzo, permiso), que es lo que Zed ya muestra. Cursor no tiene flag de esfuerzo (`src/agents/lifecycle.mjs:84-85`): ese runtime no incluye el select de esfuerzo.

Los valores de modelo son ids concretos. `detectModels` (`src/setupWizard.mjs:186-211`) es la única lista. Un alias entra al desplegable solo cuando el probe devuelve `effective` igual al id pedido, con el mismo criterio que `probeClaude` ya usa al cortar el sufijo de fecha (`src/setupWizard.mjs:106`). `opus` a secas no se ofrece. Si el cache está frío, `session/new` devuelve los selects con la lista cacheada o vacía, y un `config_option_update` posterior reemplaza la lista cuando el probe termina. Esa notificación es solo para el refresh asíncrono. El cambio que hace el usuario viaja en la respuesta de `session/set_config_option`.

Si el `system/init` trae un modelo efectivo que no coincide, el turno mata al hijo, no reenvía más texto y escribe en el hilo pedido, efectivo y versión del CLI. `stopReason` es `end_turn`. Los workers no se matan por el mismo hecho: el registro gana `modelMismatch: true` y el título de la tarjeta lo muestra. Una función, dos políticas.

### Mapa de módulos

No se añade `src/core`. `src/agents/lifecycle.mjs` ya es la fachada que MCP y ACP comparten. Reexportarla sería un pass-through.

| Módulo | Dueño | Entra | No entra |
|---|---|---|---|
| `src/acp/server.mjs` | Ciclo ACP: initialize, sesiones, prompt, cancel, `requestClient` | Enruta | Argv, JSON del CLI, formato de `agent.json` |
| `src/acp/commands.mjs` | Parseo de la primera línea | `/claude`, `/codex`, `/cursor`, `/board` | Política del turno |
| `src/acp/orchestrator.mjs` | El turno: config de dominio, hijo, resume, abort por modelo, supresión de tools zedpstack, enganche del watcher | `runOrchestratorTurn`, `applyConfigOption` | Strings `sessionUpdate` |
| `src/acp/updates.mjs` | Único emisor de `sessionUpdate` (ya construye las tarjetas) | chunks, options, tarjetas | Cuándo abortar |
| `src/acp/follow.mjs` | Tail de un agente ya elegido | Igual que hoy | Descubrir ids |
| `src/acp/cli/claude.mjs`, `codex.mjs`, `cursor.mjs` | Argv, parseo de stream, render del MCP config, permiso | Eventos de dominio | ACP y el store |
| `src/mcp/server.mjs`, `tools.mjs` | Hosts externos | Sin cambio de protocolo | Sesiones ACP |
| `src/agents/store.mjs` | Merge de lectura | Tres archivos, un escritor cada uno | Saber qué es un hilo de Zed |
| `src/agents/lifecycle.mjs` | API pública de spawn/wait/close | Escribe el archivo que le toca; compara el modelo | Protocolo ACP |
| `src/workerModels.mjs` | `modelsMatch` | La comparación | Dropdowns |
| `src/setupWizard.mjs` | `detectModels` | La lista | Preferencias del hilo |

Cadena para leer un turno: `server.mjs` → `orchestrator.mjs` → store. `follow.mjs` y `updates.mjs` son los mismos callees que ya usa el spike. Los CLI no se importan desde MCP.

`package.json` no tiene `exports`. La convención que evita el atajo es una sola: los tests del orquestador importan `runOrchestratorTurn` y pasan `spawn`. Importar `src/acp/cli/*` desde un test o desde MCP es un fallo de revisión, porque ese import se salta el abort por modelo y la supresión de tarjetas.

### Tipos y firmas

```js
/**
 * @typedef {'claude' | 'codex' | 'cursor'} OrchestratorRuntimeId
 * @typedef {'low' | 'medium' | 'high' | 'xhigh' | 'max'} Effort
 * @typedef {'default' | 'accept-edits' | 'bypass'} OrchestratorPermission
 */

/**
 * Lo que el pie edita. El esfuerzo es null en cursor: el select no existe.
 * @typedef {{
 *   runtime: OrchestratorRuntimeId,
 *   model: string,
 *   effort: Effort | null,
 *   permission: OrchestratorPermission,
 * }} OrchestratorConfig
 */

/**
 * @typedef {{
 *   sessionId: string,
 *   repo: string,
 *   config: OrchestratorConfig,
 *   resumeId: string | null,
 *   introduced: boolean,
 *   activeTurn: {
 *     controller: AbortController,
 *     childPid: number | null,
 *     agentIds: string[],
 *   } | null,
 *   attached: Set<string>,
 * }} AcpSession
 */

/**
 * Evento de dominio. El adaptador lo produce; orchestrator.mjs no ve el JSON del CLI.
 * @typedef {(
 *   { type: 'text', text: string } |
 *   { type: 'meta', effectiveModel: string, resumeId: string | null, cliVersion: string | null } |
 *   { type: 'host-tool', id: string, title: string, text: string, done: boolean } |
 *   { type: 'permission', requestId: string, title: string, detail: string } |
 *   { type: 'done', ok: boolean, error: string | null }
 * )} OrchestratorEvent
 */

/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   env: NodeJS.ProcessEnv,
 * }} McpAttachSpec
 */

/** @returns {{ ok: true } | { ok: false, reason: 'missing' | 'mismatch', requested: string, effective: string | null }} */
export function modelsMatch(requested, effective) {
  throw new Error('not implemented');
}

/**
 * @param {string} text
 * @returns {{ type: 'runtime', runtime: OrchestratorRuntimeId }
 *   | { type: 'board' }
 *   | { type: 'converse', text: string }
 *   | { type: 'usage' }}
 */
export function parsePromptCommand(text) {
  throw new Error('not implemented');
}

/**
 * @param {{ session: AcpSession, catalog: ModelChoice[], configId: string, value: string }} input
 * @returns {OrchestratorConfig}
 */
export function applyConfigOption(input) {
  throw new Error('not implemented');
}

/**
 * @param {{
 *   session: AcpSession,
 *   text: string,
 *   signal: AbortSignal,
 *   notify: (params: { sessionId: string, update: object }) => void,
 *   requestClient: (method: string, params: object) => Promise<object>,
 *   spawn?: typeof import('node:child_process').spawn,
 * }} input
 * @returns {Promise<{ stopReason: 'end_turn' | 'cancelled' }>}
 */
export async function runOrchestratorTurn(input) {
  throw new Error('not implemented');
  // TODO: resolver runtime; spawn con argv del adaptador y env del MCP;
  //        al primer meta, modelsMatch; si falla, SIGTERM al grupo, un chunk, return end_turn;
  //        text → agent_message_chunk; host-tool → tarjeta orch-;
  //        tool zedpstack → no tarjeta;
  //        permission → requestClient('session/request_permission') y escribir la respuesta del CLI;
  //        en paralelo watchNewAgents y, por id nuevo, followAgent + createWorkerUpdateSink;
  //        al cerrar, guardar resumeId. signal abort → matar grupo y closeAgent de attached.
}

/**
 * @param {{ repo: string, ownerSessionId: string, signal: AbortSignal, onAgent: (summary: object) => void }} o
 */
export function watchNewAgents(o) {
  throw new Error('not implemented');
  // TODO: poll 200 ms de listAgentIds; readAgent; emitir solo owner.sessionId coincidente y no visto.
}

/**
 * Identidad inmutable, la escribe solo spawnAgent.
 * launch.json { runnerPid } lo escribe solo el padre, una vez, tras el spawn.
 * runner.json lo reescribe entero solo execAgent (rename atómico).
 * cancel.json { at } lo crea solo stopAgent con flag wx.
 * cleanup.json { worktreeRemoved } lo escribe solo closeAgent.
 * readAgent fusiona. v1 (un solo agent.json) se lee como ya fusionado.
 * @param {string} repoRoot
 * @param {string} agentId
 */
export function readAgent(repoRoot, agentId) {
  throw new Error('not implemented');
}
```

`spawnAgent` añade en la identidad, leído del entorno del proceso MCP:

```js
owner: process.env.ZEDPSTACK_ACP_SESSION
  ? { frontend: 'acp', sessionId: process.env.ZEDPSTACK_ACP_SESSION }
  : { frontend: 'mcp', sessionId: null }
```

`workerEnv` (`src/permissions.mjs:164-178`) no copia esa variable al CLI del worker. El runner de `lifecycle.mjs:152-157` hoy hereda `process.env`; deja de importar: el dato ya está en `agent.json`.

`McpAttachSpec` lo construye `orchestrator.mjs` (node estable, `scripts/mcp.mjs`, `ZEDPSTACK_REPO`, `ZEDPSTACK_ACP_SESSION`). Cada adaptador lo vuelca a su formato en `~/.zedpstack/acp-mcp/<sessionId>.*`. Claude lo pasa con config estricto para no heredar el `claude mcp add` de usuario (`src/install.mjs:115-136`). Codex mantiene `CODEX_HOME` real (ahí está el login) y suma el servidor por config de la invocación. Cursor no escribe `.cursor/mcp.json` dentro del repo.

Permiso de dominio → flag, privado del adaptador. Claude: `default`, `acceptEdits`, `bypassPermissions`. Codex: aprobación bajo demanda no tiene canal bidireccional en `exec`; el select elige sandbox `read-only` / `workspace-write` / `danger-full-access`. Cursor: sin `--force`, `--force --sandbox enabled`, `--force` sin sandbox. `session/request_permission` existe en el turno solo cuando el adaptador emite `permission`. Claude es el que tiene canal (respuesta de control por el mismo stdin del turno). Codex y Cursor no ganan un socket puente.

Merge del registro, en `readAgent`: si existe `cancel.json`, el estado es `stopped` aunque `runner.json` diga después `completed`. Si el runner ya terminó, `stopAgent` no crea `cancel.json` (hoy sale en `src/agents/lifecycle.mjs:343`). Reconcile de PID huérfano sigue en `lifecycle.mjs:238-247`, leyendo `runner.json.runnerPid` y, si falta, `launch.json.runnerPid`.

Al cerrarse stdin del proceso ACP, cada sesión mata a su hijo y hace `closeAgent` de `attached`. Un `orchestrator.json` por sesión, con el pid del grupo, se borra al salir bien. Al arrancar, un pid cuyo proceso padre ya no existe se mata. Cancelar dos veces es la misma escritura `wx` y las mismas señales a pids ya muertos.

### Secuencia de un turno que lanza workers

```text
Zed        ACP server          orchestrator           CLI hijo              MCP (stdio del hijo)     store
 | session/prompt            |                        |                     |                        |
 |-------------------------->| runOrchestratorTurn    |                     |                        |
 |                            |----------------------->| spawn -p --resume   |                        |
 |                            |                        |-------------------->| tools/call spawn_agent |
 |                            |                        |                     |----------------------->| agent.json + launch.json
 |                            |                        | watch ve el id      |                        |   owner.sessionId
 | tool_call zp-<id>          |<-----------------------|                     |                        |
 |<---------------------------|                        |                     |                        |
 | agent_message_chunk        |<-- text --------------|                     |                        |
 |<---------------------------|                        | follow + updates    |                        |
 | tool_call_update           |<-----------------------|                     |                        |
 |<---------------------------|                        |                     |                        |
 |                            | meta.effective == pedido; guarda resumeId   |                        |
 | { stopReason: end_turn }   |<-----------------------|                     |                        |
 |<---------------------------|                        |                     |                        |
```

El hijo muere al acabar el turno. El runner del worker queda detached, como hoy (`lifecycle.mjs:152-158`), y sobrevive al CLI y a un reinicio del MCP.

### Profundidad de la interfaz

Zed sigue hablando ACP. Dentro del repo, la superficie nueva es `runOrchestratorTurn` más `applyConfigOption` y `modelsMatch`. Detrás quedan resume, formatos de stream, el config MCP, el permiso, el abort por modelo y el seguimiento de workers. `server.mjs` no ve argv. Validación en el borde: el select solo acepta un id del catálogo; el stream solo entra por el adaptador, que emite eventos de dominio. A partir de ahí el turno confía en esos eventos. `per boundary-discipline`, `per encode-lessons-in-structure`.

### Pantalla de red flags

Un módulo profundo, no una cadena larga: la política está en `orchestrator.mjs`. No hay reexport de tipos de cable ni de JSON del CLI. El estado del agente tiene un escritor por archivo y se fusiona al leer (`per separate-before-serializing-shared-state`). No hay dos maneras de elegir runtime, ni dos tarjetas para el mismo worker. `updateAgent` desaparece; no queda un RMW al lado del merge.

## Synthesis decision

Pendiente de arena. Este runner no sintetiza.

## Tradeoffs accepted

- Aceptamos el arranque del CLI en cada mensaje a cambio de que cambiar el modelo sea el argv del turno siguiente y cancelar sea matar el grupo.
- Aceptamos reconstruir texto y tarjetas desde stream-json a cambio de un solo camino para los tres runtimes y de tests con `spawn` falso. La riqueza nativa del CLI (diffs, thinking) no se reproduce.
- Aceptamos permiso interactivo solo en Claude a cambio de no inventar un bus de permiso para Codex y Cursor.
- Aceptamos un poll de 200 ms del directorio de agentes a cambio de no acoplar el MCP al ACP. Zed no envía `progressToken`.
- Aceptamos partir `agent.json` en varios archivos y subir `AGENT_RECORD_VERSION` a 2 a cambio de quitar la carrera. Los registros v1 se leen como ya fusionados.
- Aceptamos cortar el turno del orquestador cuando el modelo efectivo no coincide, a cambio de no atribuir la respuesta a un modelo que el usuario no eligió. El worker solo queda marcado.
- Aceptamos que un hilo no dibuje workers de otro frontend o de otro `sessionId`. `/board` sigue listándolos todos.
- Aceptamos `stopReason: "end_turn"` también cuando el modelo no coincide, a cambio de que el hilo siga aceptando el mensaje siguiente. El motivo va en el chunk.
- Aceptamos preferencias con última escritura gana si hay dos procesos ACP, a cambio de un solo archivo y un solo escritor dentro del proceso que Zed reutiliza.

## Alternatives considered

- Proxy ACP↔ACP hacia `claude-agent-acp` o `codex-acp`. Esconde la UI nativa del CLI y enseña al caller dos protocolos, ids de tool call, opciones de config y un MCP que hay que reinyectar. Cursor no tiene agente ACP estable, así que ese camino obligaría a un segundo mecanismo para `/cursor`. Zed marca los subagentes ACP estándar como inestables. Pierde en profundidad: la superficie pública es el protocolo entero, duplicado.
- Un PTY interactivo vivo por sesión. Esconde el resume, y enseña tres protocolos de terminal, el cambio de modelo en caliente y un cancel que tiene que hablar con un REPL. El grano de los CLI que ya ejecutamos es un proceso por prompt (`claude -p`, `codex exec`, `agent -p`).
- Reimplementar poteto-mode dentro del proceso ACP. Lo prohíbe `docs/ARCHITECTURE.md:9-21`: el routing vive en el skill, y cada versión de pstack tiene que llegar sin copiar playbooks.
- Una fachada `src/core` que reexporte lifecycle. No esconde nada. MCP y ACP ya llaman a las mismas funciones.

## Implementation reconciliation

Sin implementación. Nada que reconciliar.

## Open questions and risks

- ¿El `claude` instalado emite el permiso como mensaje de control en stdout y acepta la respuesta por stdin? Decisión por defecto: el adaptador de Claude traduce ese sobre a `OrchestratorEvent` `permission`. Si el `--help` no lo tiene, el slice de permiso se queda en el select y no se añade otro proceso.
- ¿`agent -p` tiene resume y un config MCP fuera del repo? Decisión por defecto: el adaptador de Cursor, si no hay resume, reenvía la transcripción que el propio proceso ACP fue acumulando en la sesión (texto de usuario y texto de asistente, no el JSON del CLI). Esa acumulación no sale de `orchestrator.mjs`.
- ¿Zed pinta `configOptions` devueltos en `session/new` con `type: "select"`? Decisión por defecto: ese es el esquema que implementa `updates.mjs`. Si el primer slice no dibuja el pie, se ajusta solo ese módulo.
- El probe de Claude puede tardar lo que tarda un `claude -p` (`src/setupWizard.mjs:75-108`, tope 90 s) y se cachea un día. Un alias que hoy resuelve a otro modelo sigue ofrecido hasta `refresh`. El abort del turno cubre ese hueco en el momento de hablar.

## Next implementation step

Implementar el slice 1: `/claude`, `/codex` y `/cursor` anunciados tras `session/new`, preferencias, selects vía `detectModels`, y `runOrchestratorTurn` de Claude que reenvía texto del asistente, con `spawn` inyectado en el test y sin MCP todavía.

Slices, cada uno con un chequeo:

1. Comandos de runtime, selects y un turno que solo transmite texto. Chequeo: `fakeSpawn` emite deltas y el test ve `agent_message_chunk` y `configOptions`. En Zed, el pie cambia al elegir un modelo y un saludo se escribe en el hilo.
2. Abort por `modelsMatch`. Chequeo: init con `claude-opus-4-8` y select `claude-opus-5-5` no reenvía texto posterior y el chunk cita pedido, efectivo y versión.
3. MCP efímero y supresión de tarjetas de herramientas zedpstack. Chequeo: un `tool_use` de `read_skill` no genera `tool_call`; un `tool_use` de `Read` sí, con id `orch-`.
4. Watcher y tarjetas `zp-<id>`. Chequeo: escribir un agente con `owner.sessionId` durante el turno emite `tool_call` `kind: "other"`; un agente `frontend: "mcp"` en el mismo repo no.
5. Quitar `spawn` de `available_commands` en el mismo cambio. Chequeo: la lista anunciada es `claude`, `codex`, `cursor`, `board`.
6. Cancel, segundo `session/new` en el mismo proceso, y limpieza al cerrar stdin. Chequeo: el hijo falso recibe la señal, `closeAgent` corre sobre los ids enganchados, y la otra sesión sigue viva.
7. Permiso de Claude. Chequeo: el evento `permission` llama a `requestClient('session/request_permission')` y la respuesta elegida vuelve al stdin del hijo.
8. Adaptadores de Codex y Cursor sobre la misma `runOrchestratorTurn`. Chequeo: el mismo test de texto, con otro `spawn`, cambia solo el argv.
9. Store partido y lectura v1. Chequeo: un `cancel.json` gana a un `runner.json` que después dice `completed`; un `agent.json` v1 existente sigue saliendo de `agentStatus`.

## Qué cambié y qué verifiqué

No edité nada. Leí el skill de architect, el prompt del runner, la plantilla, los red flags y el brief. En el repo: `src/acp/server.mjs`, `commands.mjs`, `follow.mjs`, `updates.mjs`, `src/agents/store.mjs`, `lifecycle.mjs`, `src/mcp/server.mjs`, `tools.mjs`, `src/permissions.mjs`, `src/runtimes/worker.mjs`, `activity.mjs`, `stream.mjs`, `src/workerModels.mjs`, `src/setupWizard.mjs` (probe y catálogos), `src/manifestLock.mjs`, `src/orchestratorHost.mjs`, `docs/ACP_SPIKE.md`, `docs/ARCHITECTURE.md`, `PROBLEMAS_ACTUALES.md`, `package.json`, `scripts/acp.mjs`. No corrí tests. No pude abrir el esquema ACP en la web.
