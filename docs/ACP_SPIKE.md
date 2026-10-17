# zedpstack en Zed (Agent Client Protocol v1)

Adaptador que expone zedpstack como agente ACP por stdio (JSON-RPC 2.0, una línea por mensaje). La arquitectura objetivo y los cortes de implementación están en [ACP_DESIGN.md](./ACP_DESIGN.md).

## Cómo funciona el hilo orquestador

Cada hilo de Zed abierto con el agente `zedpstack` es un orquestador. El hub (`src/acp/hub.mjs`) arranca un engine hijo ACP con el runtime elegido (Claude, Codex o Cursor) y le reenvía la conversación. Escribe `/claude`, `/codex` o `/cursor`, o elige **Orchestrator** en el pie del hilo, para cambiar de runtime. El cambio reinicia la conversación del engine.

El hub interviene en tres puntos de cada hilo:

1. **MCP inyectado.** En `session/new` del engine, el hub pasa los servidores MCP que envió Zed más el servidor `zedpstack` (`scripts/mcp.mjs`). Si Zed ya enviaba uno llamado `zedpstack`, se sustituye. El servidor recibe `ZEDPSTACK_ACP_SESSION` con el id de sesión del hilo y `ZEDPSTACK_REPO` con su `cwd`. El id del hilo no cambia al cambiar de runtime.
2. **Skill en el primer prompt.** El primer prompt de cada sesión de engine lleva delante, como bloque de texto aparte, el cuerpo de `SKILL.md` (el mismo texto que el prompt MCP `/zedpstack`). Después de cambiar de runtime se vuelve a anteponer. No se antepone a `/board` ni a los comandos con barra que anunció el propio engine.
3. **Tarjetas de workers.** El engine lanza workers con la herramienta MCP `spawn_agent`. Cada agente guarda en `agent.json` su `origin` (`{frontend: 'acp', sessionId}`). El hub sondea `.zedpstack/agents/` del repo y abre una tarjeta expandible (`tool_call` con `kind: other`, id `zp-<agentId>`) por cada agente cuyo origen es el hilo. La tarjeta se sigue actualizando cuando el turno que lo lanzó ya terminó. Al inicio de cada prompt el hub vuelve a sincronizar; un worker que ya había terminado aparece una sola vez, ya cerrado.

Los permisos de las herramientas MCP (`spawn_agent`, `wait_agent`, …) los pide el propio engine con `session/request_permission`, y Zed los muestra como cualquier otra herramienta.

## Registro en Zed (settings.json)

Sustituye las rutas absolutas por las de tu máquina:

```json
{
  "agent_servers": {
    "zedpstack": {
      "type": "custom",
      "command": "/usr/local/bin/node",
      "args": ["/ruta/al/repo/zedpstack/scripts/acp.mjs"],
      "env": {}
    }
  }
}
```

Variables útiles en `env`:

- `ZEDPSTACK_ACP_STREAM=content` (por defecto) o `terminal` (extensión de terminal de Zed).
- Las mismas que usa el CLI (`ZEDPSTACK_MODEL_SHEET`, `PSTACK_ROOT`, etc.).

## Comandos del hub

| Comando | Efecto |
|--------|--------|
| `/claude`, `/codex`, `/cursor` | Cambia el runtime del orquestador (reinicia la conversación) |
| `board` (o `/board`) | Tablero de agentes recientes del repo |

Los comandos del engine (por ejemplo `/compact`) se anuncian junto a estos y pasan sin cambios. Cualquier otro texto va al engine, que decide cuándo lanzar workers.

## Checklist manual (Zed 1.24.2)

1. Conectar el servidor `zedpstack` y abrir un hilo nuevo sobre el repo del proyecto.
2. Pedir algo que lance un worker, por ejemplo «Usa spawn_agent con role 'how explorer' y prompt 'Responde solo hola', espera con wait_agent y responde OK». Aprobar los permisos de las herramientas MCP.
3. Confirmar que aparece una tarjeta `zp-<agentId>`; **expandirla** para ver la salida en vivo (Zed 1.24.2 no muestra texto en tarjetas `other` colapsadas).
4. Con `ZEDPSTACK_ACP_STREAM=content`, la tarjeta arranca con «Iniciando worker…», sigue con el texto acumulado de `progress.log` y stdout no JSON (últimas ~200 líneas) y termina con el resultado.
5. Con `ZEDPSTACK_ACP_STREAM=terminal`, comprobar `kind: execute`, contenido `terminal`, salida incremental vía `_meta.terminal_output` y cierre con `terminal_exit`.
6. Pedir un worker largo, dejar que el turno termine y comprobar que la tarjeta sigue actualizándose.
7. Repetir con `/cursor` y `/codex`.

## Fuera de alcance por ahora

- La cancelación del turno se reenvía al engine, pero todavía no detiene los workers del turno (corte 4).
- Sin `session/load` ni persistencia de sesión.
- Las notificaciones `notifications/progress` del camino MCP no llegan a Zed porque Zed no envía `progressToken`; las tarjetas salen del almacén.

## Arquitectura mínima

```
Zed (stdio) → scripts/acp.mjs → src/acp/hub.mjs → engine ACP hijo (stdio)
                    │                                   ↓ MCP zedpstack (ZEDPSTACK_ACP_SESSION)
                    │                             spawnAgent → workers CLI (.zedpstack/agents/<id>/)
                    └── cards.mjs sondea .zedpstack/agents/ y emite tool_call por origin.sessionId
```
