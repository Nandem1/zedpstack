# zedpstack

Usa **pstack** (poteto-mode) en cualquier host, como Claude Code, Codex, Cursor o los agentes ACP de Zed, y elige qué CLI y qué modelo corre cada subagente.

> **El LLM decide; el dispatcher ejecuta.**

El agente con el que chateas es el orquestador. Lee poteto-mode, clasifica la tarea (bug fix, feature, investigation…) y sigue el playbook de pstack. Cada vez que pstack dice "lanza un subagente", el orquestador llama a `spawn_agent` de zedpstack, y zedpstack lo ejecuta como `claude -p`, `codex exec` o `agent -p` (Cursor) según tu hoja de modelos. Por ejemplo: explorers en haiku, los runners de architect en Codex y los reviewers de interrogate repartidos entre los tres.

## Instalación

Requisitos: Node ≥ 20, pstack instalado (plugin de Codex o de Claude Code, o `PSTACK_ROOT`) y al menos uno de `claude`, `codex` o `agent`.

```bash
git clone https://github.com/Nandem1/zedpstack.git
cd zedpstack
npm test
node scripts/dispatch.mjs install            # vista previa
node scripts/dispatch.mjs install --apply    # registra MCP + skill en Claude Code, Codex y Cursor
node scripts/dispatch.mjs doctor --human
```

`install` registra el servidor MCP (`scripts/mcp.mjs`) y enlaza los skills `zedpstack` y `setup-zedpstack`. Zed usa JSONC, así que `install --host zed` imprime el bloque `context_servers` para que lo pegues tú. Reinicia el host después.

## Uso

En el chat del host:

- `/zedpstack arregla el bug del login`. Como skill en Claude Code y Codex, o como prompt MCP (en Claude Code, `/mcp__zedpstack__zedpstack`).
- `/setup-zedpstack` para elegir modelos por rol.

Herramientas MCP que usa el orquestador:

| Herramienta | Para qué |
|-------------|----------|
| `spawn_agent` | lanza un subagente en segundo plano (`prompt`, `role`/`slot` o `model`, `readonly`, `subagent_type`, `skills`) |
| `wait_agent` | espera a uno o varios agentes y devuelve sus informes |
| `agent_status` / `agent_result` | progreso en vivo e informe final, con el commit si es un writer |
| `apply_agent_changes` | trae el commit de un writer a tu working tree, sin commitear |
| `close_agent` | detiene el agente y opcionalmente borra su worktree |
| `list_agents` / `list_models` / `read_skill` | inventario, hoja de modelos y lectura de skills de pstack |

### Ver los subagentes

- **En el chat**: cada respuesta de `spawn_agent` y `wait_agent` empieza con una lista al estilo de Cursor, y el orquestador la publica en su mensaje:

  ```
  ⠿ How: backend tracking SQL  composer-2.5 · Cursor
    > Searching for "UPDATE tracking"
  ⠿ Why: git history  gpt-6.1-sol · Codex
    Leo el diff y comparo.
  ✓ How: frontend tracking PUT  haiku → claude-haiku-4-5 · Claude
    done in 48s
  ```

  `haiku → claude-haiku-4-5` es el modelo que el CLI realmente usó.
- **En vivo**: `node scripts/dispatch.mjs top` en un panel de terminal (por ejemplo el de Zed) redibuja la lista con spinners y tiempo transcurrido.
- **Dentro de la herramienta**: `wait_agent` envía notificaciones de progreso MCP con la lista; el host las muestra si las soporta.

Sin MCP, los mismos comandos existen en la CLI: `node scripts/dispatch.mjs agent spawn|wait|status|result|apply|close|list` (salida JSON).

## Modelos

`~/.zedpstack/pstack-models.md` usa las mismas filas de rol que `/setup-pstack`, pero cada valor es un slug que un CLI puede lanzar:

```
how explorer: haiku
architect runners: gpt-6.1-sol, opus
interrogate reviewers: opus, gpt-6.1-sol, composer-2.5
```

Para elegirlos, usa `/setup-zedpstack`, que sigue el mismo flujo que `/setup-pstack`: primero el effort (default, medium o high), después muestra los roles actuales con el modelo que corre de verdad y sus problemas, pregunta qué roles cambiar y, para cada uno, el modelo (uno solo; los paneles aceptan varios). Las opciones son una lista corta de Claude, GPT, Composer y Grok, y cualquier otro modelo de Cursor (Grok, Gemini, Claude, GPT) entra por "Other". Los alias de Claude se prueban contra tu cuenta, así que un modelo que no puedes usar (por ejemplo, uno que exige créditos) ni siquiera se ofrece. Por debajo usa `setup_plan` y `setup_write` (MCP) o `dispatch setup plan|write`.

El runtime se deduce del slug. Para forzarlo, usa un prefijo: `cursor:claude-opus-5-5`. La hoja del host (por ejemplo `~/.cursor/rules/pstack-models.mdc`) nunca se usa para los workers.

### Abre un hilo orquestador en Zed

Añade esta entrada a `settings.json` de Zed. Sustituye las rutas por las de tu máquina:

```json
{
	"agent_servers": {
		"zedpstack": {
			"type": "custom",
			"command": "/usr/local/bin/node",
			"args": ["/ruta/zedpstack/scripts/acp.mjs"],
			"env": {
				"ZEDPSTACK_MODEL_SHEET": "/ruta/worker-models.md"
			}
		}
	}
}
```

Desde el registro de agentes de Zed, instala los engines que quieras usar. Claude corresponde a `claude-acp`, distribuido como `@agentclientprotocol/claude-agent-acp`; Codex a `codex-acp`, como `@agentclientprotocol/codex-acp`; Cursor usa `cursor-agent acp`. El hub consulta ese registro. También admite overrides y, como último recurso, versiones fijadas de Claude y Codex por `npx`, o Cursor desde `PATH`.

Autentica los runtimes que vayas a usar con `claude auth login`, `codex login` o `agent login`. Abre un hilo nuevo con el agente **zedpstack** sobre tu repo. El hub arranca un engine por hilo, inyecta su servidor MCP y añade la skill orquestadora al primer mensaje. Describe la tarea en ese hilo. El engine conversa y delega trabajo mediante `spawn_agent` según pstack.

Los comandos del hilo son:

| Comando | Resultado |
|---|---|
| `/claude`, `/codex`, `/cursor` | Elige el engine y reinicia su conversación |
| `/board` | Muestra los agentes recientes del repo |
| `/edits` | Informa del permiso de edición, modo del engine y nivel de bloqueo o aviso |
| `/edits on`, `/edits off` | Permite ediciones directas o restablece la guarda en ese hilo |

En el pie del hilo, **Orchestrator** cambia el runtime. Los otros desplegables proceden del engine y eligen modelo, esfuerzo y modo. El hub guarda esas elecciones por runtime en `~/.zedpstack/acp-prefs.json`, incluso con varios hilos abiertos. Por ejemplo, escribe `/cursor` y elige `grok-4.6` si tu CLI lo ofrece. El desplegable del orquestador y la hoja de workers son independientes. La hoja puede contener:

```text
how explorer: claude:claude-haiku-5-5
bug-fix: codex:gpt-6.1-sol
architect runners: codex:gpt-6.1-sol, claude:claude-opus-5-5
```

Omite `default_config_options` de Zed o incluye solamente valores válidos para todos los runtimes que uses. Un modo de Claude como `bypassPermissions` no es válido para Cursor. El hub rechaza esos valores sin guardarlos. Si envías varios valores consecutivos, aplica primero `zp.runtime` y valida los demás contra el engine elegido.

`/codex` reutiliza el login de `codex login`. Solo elige autenticación por API key si el entorno del hub contiene `CODEX_API_KEY` u `OPENAI_API_KEY`. `node scripts/dispatch.mjs doctor --human` muestra la resolución, versión, ejecutable o caché y política de autenticación de cada engine sin iniciarlos ni consultar la red. `--json` devuelve el mismo diagnóstico estructurado.

Cada worker aparece como una tarjeta expandible con su actividad, salida y resultado. Solo ves las tarjetas originadas en ese hilo, aunque haya varios sobre el mismo repo. Las tarjetas siguen actualizándose después de terminar el mensaje que lanzó el worker. Expándelas para leer el contenido; `ZEDPSTACK_ACP_STREAM=terminal` permite usar la representación de terminal de Zed.

Cancelar un turno cancela el turno del engine y detiene los workers creados durante él. Espera los procesos y tarjetas de esos workers antes de responder `cancelled`. El proceso del engine continúa, y los workers de turnos anteriores y de otros hilos siguen vivos. Cerrar un hilo termina su engine y sus observadores; los workers quedan desacoplados. Si el engine cae, el siguiente mensaje inicia otro y avisa de la pérdida de conversación.

El hilo empieza con `/edits off`. El hub rechaza permisos internos de edición y escrituras que pasan por el cliente. Claude en `default` o `plan`, y Cursor en `ask` o `plan`, muestran el nivel `bloquea`. Claude en `acceptEdits` o `bypassPermissions`, y Cursor en `agent`, muestran `solo avisa`: pueden escribir sin preguntar y el hub avisa cuando recibe la ubicación o el diff. `/edits` no cambia el modo del engine. `dispatch install` instala además el hook de Claude Code, independiente de este interruptor. Consulta la [matriz de ediciones y sus límites](./docs/ACP_DESIGN.md#ediciones-internas-y-modo-del-engine).

Las acciones MCP que aplican cambios, escriben en el checkout o descartan trabajo preguntan en Zed con **Permitir**, **Permitir siempre en este hilo** y **Rechazar**. La guarda de ediciones del orquestador no bloquea el trabajo delegado que aprobaste.

## Seguridad

- Los subagentes con `readonly: true` no pueden escribir: Claude solo recibe `Read,Grep,Glob`, Codex corre con `-s read-only` y Cursor con `--mode ask`.
- Los writers trabajan en un git worktree propio (`~/.zedpstack/worktrees/…`, rama `zedpstack/<id>`). zedpstack commitea su resultado y tú decides si lo aplicas.
- Cada worker recibe un entorno filtrado: PATH, HOME y las credenciales de su propio CLI.

## Modo batch (sin orquestador)

Los playbooks fijos de versiones anteriores siguen disponibles:

```bash
node scripts/dispatch.mjs run --playbook how-investigation --goal "¿Cómo funciona X?" --repo /ruta --tee-events
```

Ver [docs/PSTACK_ADAPTERS.md](./docs/PSTACK_ADAPTERS.md) y [docs/STREAMING.md](./docs/STREAMING.md). El diseño completo está en [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Licencia

MIT, ver `LICENSE`. El contenido de pstack no está incluido en este repo; ver `docs/UPSTREAM.md`.
