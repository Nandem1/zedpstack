# Arquitectura de zedpstack

## Problema

pstack (poteto-mode y sus skills) está escrito sobre la herramienta `Agent` de Claude Code. En otro host esa herramienta no existe o no admite el mismo modelo. Codex tiene su propio `spawn_agent` (ver `poteto-mode/references/codex-tools.md`), pero solo lanza modelos de Codex. Cursor tiene `Task`, pero solo con modelos de Cursor.

zedpstack quiere que el orquestador sea **cualquier** agente ACP en Zed (Claude Code, Codex o Cursor CLI) y que cada rol de pstack corra en el CLI y el modelo que el usuario eligió. Por ejemplo, explorers en haiku, los runners de architect en Codex y un reviewer en Cursor.

## Decisión central: zedpstack es el `Agent` portable, no un segundo orquestador

```
host ACP (Claude Code | Codex | Cursor) en Zed
 └─ poteto-mode (routing, playbooks, judgment)        ← pstack, sin cambios
     └─ spawn_agent / wait_agent / ...               ← zedpstack MCP
         └─ claude -p | codex exec | agent -p          ← según la hoja de workers
```

- **El routing es de pstack.** El orquestador lee poteto-mode, clasifica la tarea (Investigation, Bug fix, Feature, …) y sigue el playbook. zedpstack no repite esa lógica, así que cada versión nueva de pstack llega sola.
- **zedpstack solo hace el despacho**: resuelve el modelo, aplica permisos, aísla a los writers, ejecuta el proceso y devuelve el informe.
- **`references/zedpstack-tools.md`** cumple para zedpstack el mismo papel que `codex-tools.md` para Codex: traduce cada campo de `Agent` a un argumento de `spawn_agent`.

Las versiones 0.1–0.5 iban en la dirección contraria: playbooks fijos (`how-investigation`, `architect-sketch`, …) con su propio paso de judgment, es decir, un segundo poteto-mode más rígido. Esos playbooks siguen disponibles como "modo batch" (`dispatch run`) para cuando no hay orquestador, pero el camino principal es el MCP.

## Piezas

| Pieza | Archivo | Qué hace |
|-------|---------|----------|
| Servidor MCP | `src/mcp/server.mjs`, `src/mcp/tools.mjs` | JSON-RPC por stdio, sin dependencias. Ofrece las herramientas y el prompt `/zedpstack` |
| Ciclo de vida de agentes | `src/agents/lifecycle.mjs` | spawn → runner separado → worker → snapshot → result |
| Registro en disco | `src/agents/store.mjs` | `<repo>/.zedpstack/agents/<id>/`, un archivo por actor y estado derivado al leer (ver D-09); `.zedpstack/` se auto-ignora |
| Worktrees | `src/agents/worktree.mjs` | `~/.zedpstack/worktrees/<repo>-<hash>/<id>` en la rama `zedpstack/<id>` |
| Prompt del worker | `src/agents/prompt.mjs` | `subagent_type` → qué archivo de pstack lee primero; reglas de solo lectura o escritura |
| Ejecución del CLI | `src/runtimes/worker.mjs` | Un único ejecutor para los tres CLIs, prompt siempre por stdin |
| Permisos | `src/permissions.mjs` | argv por runtime y por perfil (`read-only`, `workspace-write`) |
| Modelos | `src/workerModels.mjs`, `src/modelRouting.mjs` | rol de la hoja → slot → slug → runtime |
| Instalación | `src/install.mjs` | registra el MCP y los skills en cada host |
| Diagnóstico | `src/setupReport.mjs` | `dispatch doctor` |

## Decisiones

### D-01. Una hoja de workers, con las filas de rol de pstack

`~/.zedpstack/pstack-models.md` usa exactamente las filas de `/setup-pstack` (`how explorer`, `architect runners`, …). Los valores son slugs que un CLI puede lanzar. La hoja del host (`~/.cursor/rules/pstack-models.mdc`, `~/.claude/pstack-models.md`) **nunca** se usa como respaldo: sus slugs pertenecen a la herramienta nativa del host. Ese respaldo era la causa del `model_not_found` de la v0.5.

### D-02. Provider ≠ runtime

El runtime se deduce del slug (`haiku` → claude, `gpt-*`/`*-sol` → codex, `composer-*` → cursor). Cuando un slug existe en varios CLIs (Cursor también sirve Claude y GPT), se fuerza con un prefijo: `cursor:claude-opus-5-5`. Un slug desconocido corre en claude y queda una nota; nunca se rechaza en silencio.

### D-03. Siempre en segundo plano, con un runner separado

`spawn_agent` crea el registro, lanza `dispatch agent exec` en su propio grupo de procesos y devuelve el control al instante. El runner sobrevive a reinicios del servidor MCP o del host, y `list_agents` lo vuelve a encontrar. `close_agent` mata el grupo completo (runner y worker). Si el runner muere sin terminar, la lectura deriva `failed` por PID sin escribir nada (D-09).

### D-04. Los writers trabajan en worktrees por defecto

pstack exige worktrees para writers en paralelo (swarm, orchestrate). zedpstack lo hace por defecto: cada writer recibe su worktree desde `HEAD`, y al terminar zedpstack commitea lo que dejó. El orquestador revisa el commit y lo trae con `apply_agent_changes` (`cherry-pick --no-commit`). Con `isolation: "none"` se escribe en el sitio, pensado para un único writer que necesita ver cambios sin commitear.

### D-05. Permisos por CLI

| | read-only | writer |
|---|---|---|
| Claude | `--tools Read,Grep,Glob`, `dontAsk` | `acceptEdits`, `Edit,Write,Bash` con allowlist de comandos |
| Codex | `-s read-only` | `-s workspace-write` |
| Cursor | `--mode ask` (sin `--force`) | `--force --sandbox enabled` |

Los workers reciben un entorno filtrado (PATH, HOME y las credenciales de su propio CLI) y acceso de lectura al directorio de skills de pstack.

### D-06. Los campos de `spawn_agent` copian los de `Agent`

`prompt`, `description`, `subagent_type`, `model` y `readonly` significan lo mismo que en pstack. `role` y `slot` reemplazan "el modelo de la línea X de la hoja". Así la traducción que hace el orquestador es mecánica y no requiere criterio.

### D-07. Un solo texto para el skill y el prompt

El prompt MCP `/zedpstack` es el cuerpo de `SKILL.md`. En Claude Code aparece como `/mcp__zedpstack__zedpstack`, y el symlink del skill da además `/zedpstack`.

### D-08. Visibilidad: una lista, cuatro superficies

La lista de subagentes de Cursor es interfaz nativa de su herramienta `Task`, y ningún MCP puede dibujarla. zedpstack ofrece lo más parecido en cada superficie que sí controla. Las cuatro salen de `src/agents/board.mjs`:

1. **Resultado de la herramienta**: el primer bloque de texto de `spawn_agent`/`wait_agent`/`agent_status`/`list_agents`.
2. **Chat**: `SKILL.md` obliga al orquestador a copiar la lista en su mensaje tras cada ronda, con títulos `<Skill>: <ángulo>`.
3. **Progreso MCP**: `wait_agent` envía `notifications/progress` con la lista cuando el host pasa un `progressToken`.
4. **Terminal**: `dispatch top` la redibuja en vivo.

La actividad sale de la salida del propio CLI (herramientas y narración) sin llamadas extra a modelos. El modelo efectivo que reporta el CLI se muestra junto al modelo pedido, con el resultado de la verificación de modelo (sección siguiente).

### D-09. Almacén de agentes: un escritor por archivo, estado derivado

Varios procesos tocan el mismo agente: el servidor MCP o el CLI que lo lanza, el runner, quien lo detiene y quien lee el tablero. En vez de cerrojos, cada archivo de `<repo>/.zedpstack/agents/<id>/` tiene un solo escritor:

| Archivo | Escritor | Cómo |
|---|---|---|
| `agent.json` (AgentSpec, versión 2) | `spawnAgent`, una vez | creación exclusiva; nunca se reescribe |
| `launch.json` `{runnerPid}` | `spawnAgent`, una vez | creación exclusiva |
| `run.json` (RunState) | solo el runner (`execAgent`) | reemplazo completo con tmp+rename |
| `stop.json` `{requestedAt, by}` | `stopAgent`/`closeAgent` | creación exclusiva; el segundo stop no hace nada |
| `cleanup.json` `{removedAt, branchDeleted}` | `closeAgent` | creación exclusiva |

La creación exclusiva escribe un temporal y lo enlaza con `link`, que falla si el destino existe. Un lector nunca ve el archivo a medio escribir, cosa que un `open` con `wx` no garantiza.

El spec guarda `origin {frontend, sessionId, pid}`: `acp` cuando el proceso tiene `ZEDPSTACK_ACP_SESSION`, `cli` desde `dispatch agent spawn` y `mcp` en otro caso. `expectedModel` es el modelo que se espera que corra el CLI (ver «Verificación de modelo»).

`loadAgent` une los archivos en un AgentView `{spec, run, launch, stop, cleanup, status, error, finishedAt, modelCheck}`. `deriveStatus` es pura y sigue este orden: `stop.json` da `stopped` aunque el runner escriba después un resultado; un `outcome` da `completed` o `failed`; un runner vivo con `run.json` da `running`; sin `run.json`, un runner vivo o un spec de menos de 15 s da `starting`; cualquier otro caso da `failed` (el runner murió sin terminar). Ninguna lectura escribe, así que `status`, `list_agents` y el tablero no compiten con el runner.

Un `agent.json` cuya versión difiere de 2 se lee con el adaptador v1. Los registros v1 guardaban `status` y podían no declarar versión. El adaptador produce el mismo AgentView sin reescribir el archivo. En versión 2, `loadAgent` ignora los campos heredados `status`, `error`, `finishedAt` y `updatedAt` que un proceso antiguo haya añadido a `agent.json`.

## Verificación de modelo

Un dictamen nunca se atribuye en silencio a un modelo que el usuario no pidió. `src/modelCheck.mjs` es el único módulo que sabe comparar modelos.

- **Esperado.** `spawnAgent` guarda `spec.expectedModel` con `expectedModelFor`. Un id concreto (`claude-opus-5-5`, `composer-2.5`) se espera a sí mismo. Un alias (`opus`, `haiku`, `default`, `auto`) espera el `effective` de la caché de sondeos de `/setup-zedpstack` (`~/.zedpstack/model-probe.json`), o `null` si nadie lo sondeó. Leer la caché nunca lanza un sondeo.
- **Efectivo.** El runner guarda en `run.json` el modelo que reporta el CLI: `init` en Claude y Cursor, la cabecera `model:` en Codex.
- **Comparación.** `loadAgent` deriva `modelCheck` sin escribir. `normalizeModelId` pasa a minúsculas, quita parámetros entre corchetes, sufijos de fecha y decoraciones de presentación (`1M`, `256K`, niveles de esfuerzo), así que `Composer 2.5` equivale a `composer-2.5`. Un prefijo de familia no basta: `claude-opus-4-8` no satisface `claude-opus-5-5`.

| `state` | Cuándo | Qué se ve |
|---|---|---|
| `ok` | El efectivo normalizado coincide con el esperado | `opus → claude-opus-5-5` |
| `unverified` | Sin evidencia todavía, o un alias sin sondeo | `haiku → claude-haiku-5-5 (alias)` |
| `mismatch` | El efectivo difiere del esperado | `opus → claude-opus-4-8 ⚠ esperado claude-opus-5-5` |

`model_check` se añade a `agent_status`, `agent_result`, `wait_agent`, `list_agents` y las filas del tablero; los campos existentes no cambian. Un `mismatch` no hace fallar al worker: queda `completed`, pero `agent_result` añade `warnings` y antepone esa línea a `text`, así que la tarjeta ACP también empieza por el aviso. El título de la tarjeta se actualiza al terminar con la etiqueta del modelo.

Cuando la API rechaza un modelo porque el CLI es antiguo («requires Claude Code 2.1.280 or later»), el error del worker nombra la versión instalada, por ejemplo `claude CLI 2.1.195 cannot run claude-opus-5-5: the API requires 2.1.280 or later`. El repo no registra versiones mínimas de los CLI, así que `doctor` no compara versiones.

`setup_plan` añade `pin` (el id concreto sondeado) a cada alias que corre y una línea en `recommendations` que propone fijarlo. `setup_write` acepta ids concretos y, si se escribe un alias, lo escribe tal cual y añade a `warnings` el modelo que corre hoy.

**Orquestador.** `claude-agent-acp@0.93.0` emite `usage_update._meta["_claude/model"]` con el modelo que respondió (comprobado el 2026-10-17: `claude-sonnet-5-5` con el modelo `default`). El hub compara ese valor con el `currentValue` de la opción `model` y, si es un id concreto distinto, escribe una vez en el hilo la línea de `mismatch`. Un alias del orquestador no se contrasta, porque la caché de sondeos describe el CLI de los workers y no el SDK que lleva el engine. `cursor-agent acp` no emite ningún campo de modelo, así que el orquestador de Cursor queda `unverified`. Codex ya autentica con el login existente, pero no se comprobó un turno ni se añadió un adaptador de evidencia del modelo efectivo.

## Engines, entorno y preferencias ACP

`src/acp/engine.mjs` resuelve cada engine por override de entorno, config del usuario, registro de Zed y fallback fijado, o `cursor-agent acp` en `PATH`. Devuelve un registro con comando, origen, paquete y versión. `startEngine` y el diagnóstico local de `src/acp/diagnostics.mjs` usan esa misma resolución. `dispatch doctor` informa del ejecutable y de la caché npx exacta sin arrancar engines ni consultar la red. `zp.runtime` conserva los tres runtimes y describe como `(no instalado)` aquellos sin ejecutable o caché completa.

`src/acp/auth.mjs` define la política de autenticación. Codex prefiere `chat-gpt`, que reutiliza el login de `codex login`; solo permite `api-key` con `CODEX_API_KEY` u `OPENAI_API_KEY` en el hub. Cursor usa `cursor_login` y Claude `claude-login` cuando los anuncian. Un método desconocido nunca se elige por su posición o nombre. El error enumera los métodos disponibles y el comando de login. Con ningún método anunciado se pasa directamente a `session/new`.

`engineMcpEnv` construye el `env` explícito del MCP inyectado. Reenvía `PATH`, `HOME` y todas las variables `ZEDPSTACK_*` y `PSTACK_*`. Sesión, repo, puente y pid se sustituyen por los del hub actual. Esto conserva `ZEDPSTACK_HOME`, `ZEDPSTACK_MODEL_SHEET` y `PSTACK_ROOT` aunque el engine no herede su entorno al MCP. Las claves de proveedor no se reenvían por este canal.

`src/acp/options.mjs` valida las elecciones contra las opciones nativas o derivadas, incluidas las listas agrupadas y booleanas. `src/acp/hub.mjs` mantiene una cola por sesión. Agrupa las peticiones consecutivas hasta `setImmediate` y ejecuta primero los cambios `zp.runtime` pendientes; las demás opciones se validan después del cambio. Un valor inválido devuelve `-32602` sin envío al engine, cambio de estado ni escritura de preferencias. Las notificaciones de un engine sustituido no alteran las opciones del nuevo.

Las preferencias se guardan en `acp-prefs.json` como `{lastRuntime, perRuntime: {claude: {...}, codex: {...}, cursor: {...}}`. Cada runtime recupera solamente sus valores. Antes de cada reaplicación el hub valida contra las opciones vivas y elimina las entradas obsoletas del archivo, con un aviso en stderr por entrada eliminada. Los errores transitorios de RPC conservan los valores válidos.

El modelo del orquestador proviene del desplegable del engine. El flujo Cursor con `grok-4.6` usa esa selección guardada y una hoja de workers independiente para asignar Claude y Codex por rol. `default_config_options` de Zed se omite o contiene valores válidos en todos los runtimes usados. El ejemplo de `agent_servers.zedpstack` custom está en [ACP_DESIGN.md](./ACP_DESIGN.md#orquestador-cursor-y-workers-por-rol).

## Cancelación y supervisión (hub ACP)

El hub ACP (`scripts/acp.mjs`, `src/acp/hub.mjs`) lanza un engine por hilo y debe dejarlo todo limpio cuando el usuario cancela, el engine cae, el hilo se cierra o Zed muere. Los workers son la excepción: siguen desacoplados (D-03).

**Turno.** Mientras hay un `session/prompt` abierto, la sesión guarda `turn = {startedAt, controller, promptPromise, cancelling}`. Un `session/cancel` sin turno no hace nada. Con turno, el primero crea `cancelling` y los siguientes esperan esa misma promesa. La cancelación sigue este orden:

1. Reenvía `session/cancel` al engine y aborta el controlador del turno.
2. Detiene los workers de la sesión creados desde `startedAt` que no hayan terminado (`stopSessionAgents` en `lifecycle.mjs`, que usa `stopAgent`). Los de turnos anteriores siguen vivos.
3. Responde `cancelled` al engine en cada `session/request_permission` que Zed aún no contestó.
4. Espera la respuesta del engine al prompt, como mucho 10 s, y repite el paso 2 para un `spawn_agent` que el engine estuviera atendiendo cuando llegó la cancelación.
5. Espera a que los procesos de esos workers mueran y a que sus tarjetas se cierren en `failed` (`cards.whenFinished`), como mucho 10 s. Solo entonces responde `stopReason: 'cancelled'`.

**Caída del engine.** Si el engine sale con un prompt abierto, el hub envía un mensaje con el código o la señal y las últimas líneas de stderr, y responde `refusal`. La sesión conserva `zp.runtime`, `engine` pasa a `null`, y los workers y sus tarjetas siguen. El siguiente prompt arranca un engine nuevo, avisa de que la conversación anterior se perdió y vuelve a anteponer la skill. Los arranques de una sesión van en serie y un segundo prompt durante el reinicio recibe «turn in progress», así que nunca se arrancan dos engines.

**Cierre y tope.** `session/close` mata el engine del hilo y descarta sus tarjetas. Si Zed no lo envía, la sesión dura hasta el cierre del hub. Antes de arrancar un engine, si ya hay `ZEDPSTACK_ACP_MAX_ENGINES` vivos (8 por defecto), el hub detiene el engine inactivo usado hace más tiempo. Esa sesión lo vuelve a arrancar en su siguiente prompt, con el mismo aviso de conversación perdida.

**Procesos.** Cada engine corre en su propio grupo. `kill` cierra su stdin, envía SIGTERM al grupo y espera hasta 3 s a que el grupo entero desaparezca. Pasado ese plazo envía SIGKILL. Hace falta esperar al grupo y no solo al líder porque `npx` termina antes que el agente que lanzó. `hub.shutdown` (EOF de stdin, SIGTERM, SIGINT, `uncaughtException`, `unhandledRejection`) cierra las tarjetas y aplica `kill` a todos los engines. Después escribe en stderr una línea por sesión con los workers que deja vivos, y el proceso sale. Un SIGKILL al hub no permite ese cierre, así que el hub pasa `ZEDPSTACK_PARENT_PID` con su pid al entorno del engine y al del MCP inyectado. `scripts/mcp.mjs` termina cuando ese pid desaparece (sondeo cada 2 s) o cuando su stdin llega a EOF y ya respondió lo recibido. De un engine de terceros se espera que termine con el EOF de su stdin.

| Variable | Quién la lee | Efecto |
|---|---|---|
| `ZEDPSTACK_PARENT_PID` | `scripts/mcp.mjs`, el engine falso de las pruebas | Sale cuando ese pid muere |
| `ZEDPSTACK_ACP_MAX_ENGINES` | hub ACP | Engines vivos como máximo, 8 por defecto |

## Permisos y guarda de ediciones (hub ACP)

Dentro de un hilo de Zed, las acciones de zedpstack que tocan el checkout del usuario se preguntan con la UI nativa de permisos de Zed, sea cual sea el modo de permisos del engine (incluido `bypassPermissions`). Fuera de ACP nada cambia.

**Puente.** El hub abre un socket Unix en `<ZEDPSTACK_HOME o ~/.zedpstack>/run/acp-<pid>.sock`. El directorio queda en 0700 y el socket en 0600. Al arrancar borra los sockets de pids muertos, y al cerrarse borra el suyo. El MCP inyectado recibe la ruta en `ZEDPSTACK_ACP_BRIDGE`. El protocolo es JSON por líneas. La petición es `{id, sessionId, action, agentId?, title, detail}` y la respuesta `{id, allowed, reason?}`. `askHuman` (`src/acp/bridge.mjs`) concede al instante y sin E/S cuando `ZEDPSTACK_ACP_BRIDGE` no existe, que es el caso de Claude Code, Codex y Cursor por MCP. Con la variable puesta falla cerrado: un socket inalcanzable, un cierre antes de responder o 10 min sin respuesta equivalen a rechazo. Una ruta de socket de más de 103 bytes no se abre. Ese hub lo registra y las acciones se rechazan.

**Pregunta.** El hub emite `session/request_permission` a Zed con el id de sesión externo. El `toolCall` lleva `toolCallId: zp-perm-<n>`, `status: pending`, `kind` según la acción y el detalle como texto. Las opciones son `allow_once`, `allow_always` y `reject_once`. `allow_always` vale para esa acción en ese hilo hasta que el hilo se cierra. Al resolverse, el hub cierra la tarjeta con `tool_call_update` `completed` o `failed`. Cancelar el turno, cerrar el hilo, reiniciar o perder el engine, apagar el hub o desconectar el MCP resuelven cada pregunta pendiente como rechazo, con el motivo en `reason`. Las preguntas simultáneas son independientes.

| Herramienta MCP | Cuándo pregunta | `kind` | Respuesta al rechazar |
|---|---|---|---|
| `apply_agent_changes` | El agente terminó y dejó un commit. El detalle trae agente, commit, rama, archivos y diffStat | `edit` | `{agent_id, commit, applied: false, error: 'rejected by user', reason}` |
| `spawn_agent` | Writer que escribe en el checkout: `isolation: 'none'`, o un repo sin git | `execute` | `{agent_id: null, spawned: false, isolation: 'none', cwd, error, reason}` |
| `close_agent` | `remove_worktree` o `delete_branch` sobre un writer con worktree no aplicado, que sigue corriendo o dejó un commit | `delete` | `{agent_id, closed: false, worktree: null, error, reason}` |
| `setup_write` | Siempre, salvo `dry_run` | `edit` | `{written: false, changed: false, error, reason}` |

Un rechazo no tiene efectos. Las lecturas nunca pasan por el puente. `apply_agent_changes` deja `apply.json` en el agente cuando aplica, y `close_agent` lo usa para saber que ese trabajo ya llegó al checkout.

**Guarda de ediciones.** El hub revisa las peticiones del engine al cliente con las mismas reglas que el hook PreToolUse (`editVerdict` en `src/guard.mjs`). Rechaza un `fs/write_text_file` cuya ruta real cae dentro del cwd de la sesión y fuera de `.zedpstack/`. También rechaza un `terminal/create` que la heurística de Bash marca como escritura en el repo. El error JSON-RPC (-32000) dice «el orquestador no edita archivos: delega con spawn_agent (o /edits on)» y nombra el destino. Cada rechazo se anota en `.zedpstack/orchestrator-audit.jsonl`. El resto pasa sin cambios. `/edits on` y `/edits off` cambian `editsAllowed` solo en ese hilo, que empieza en `off`. `/edits` sin argumento muestra el estado. El interruptor no toca `.zedpstack/session.json`, porque ese marcador es del repo y lo comparten todos los hilos y el hook de Claude Code.

**Límite medido.** El 2026-10-17, con un cliente que anunciaba `fs.readTextFile`, `fs.writeTextFile` y `terminal`, `claude-agent-acp@0.93.0` y `cursor-agent acp` crearon el archivo con su herramienta interna (Write o Edit File). Ninguno llamó a `fs/write_text_file`, así que la guarda de protocolo no los ve. Con Claude queda el hook PreToolUse (`dispatch install`), que el engine sí ejecuta. Lo bloqueó con el marcador de sesión activo. `/edits on` no levanta ese hook. Para ese repo hace falta `dispatch session allow-edits`. Con Cursor no queda ninguna defensa contra las ediciones directas del orquestador. Los permisos de las acciones de zedpstack sí funcionan con los dos engines.

| Variable | Quién la lee | Efecto |
|---|---|---|
| `ZEDPSTACK_ACP_BRIDGE` | MCP inyectado (`askHuman`) | Socket del puente de permisos. Sin ella, todo se concede |

## Límites conocidos

- Un CLI separado no puede heredar el modelo del orquestador (`inherit-parent`), así que corre el default de pstack y lo deja anotado.
- No se puede reanudar un agente ni mandarle mensajes; se lanza uno nuevo con el alcance consolidado (que es lo que poteto-mode recomienda de todos modos).
- El writer de Claude no tiene sandbox de SO, solo la allowlist de comandos. Si una tarea delicada necesita sandbox real, usa Codex o Cursor.
- La reenvío de context servers de Zed a los agentes ACP depende de la versión de Zed. Si no llegan, registra el MCP directamente en el host (`dispatch install`).
- Dentro de un hilo ACP con `cursor-agent acp`, el orquestador puede editar el repo directamente. Ver «Permisos y guarda de ediciones».
