# Spike ACP (Agent Client Protocol v1)

Adaptador que expone zedpstack como agente ACP por stdio (JSON-RPC 2.0, una línea por mensaje). La arquitectura objetivo y los cortes de implementación están en [ACP_DESIGN.md](./ACP_DESIGN.md).

El hub ACP (`src/acp/hub.mjs`) reenvía la conversación a un engine hijo ACP (Claude/Codex/Cursor) y sigue manejando `/spawn` y `/board` localmente. Escribe `/claude`, `/codex` o `/cursor` (o elige **Orchestrator** en el pie del hilo) para cambiar de runtime; eso reinicia la conversación del engine hijo.

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

## Comandos de prompt

Zed 1.24+ registra `spawn` y `board` como comandos ACP (`available_commands_update` tras cada `session/new`). En el cuadro de texto puedes usar la forma con barra (`/spawn …`) o sin ella (`spawn …`).

| Comando | Efecto |
|--------|--------|
| `spawn <rol> :: <prompt>` (o `/spawn …`) | Un worker con el rol de la hoja de modelos |
| `spawn xN <rol> :: <prompt>` | N workers en paralelo (N ≤ 50) |
| `board` (o `/board`) | Tablero de agentes recientes |

Solo la **primera línea** es la cabecera hasta `::`; el prompt puede continuar en líneas siguientes (incluidas líneas que empiecen por `/`).

Cualquier otro texto se reenvía al engine ACP hijo activo (respuesta en streaming vía `agent_message_chunk`).

## Checklist manual (Zed 1.24.2)

1. Conectar el servidor `zedpstack` y abrir una sesión nueva apuntando al repo del proyecto (`cwd` absoluto).
2. Probar `/spawn how explorer :: pregunta de prueba` y confirmar que aparece una tarjeta de herramienta (`kind: other`); **expandir la tarjeta** para ver la salida en vivo (sin control de expansión no se muestra el texto).
3. Repetir con `x3` y `x10` y verificar diez `toolCallId` distintos (`zp-<agentId>`).
4. Con `ZEDPSTACK_ACP_STREAM=content` (por defecto), expandir la tarjeta y comprobar que arranca con «Iniciando worker…», luego texto acumulado de `progress.log` y stdout no JSON (últimas ~200 líneas) en `tool_call_update` con `kind: other` en el `tool_call` inicial.
5. Con `ZEDPSTACK_ACP_STREAM=terminal`, comprobar `tool_call` con `kind: execute`, contenido `terminal`, `terminal_info.cwd` del repo, salida incremental vía `_meta.terminal_output` (CRLF) sin campo `content` en updates, y cierre con `terminal_exit`.
6. En modo content, confirmar que hay que expandir manualmente la tarjeta para ver updates (Zed 1.24.2 no muestra texto en tarjetas `other` colapsadas).
7. Hacer scroll en una ejecución larga y verificar que el contenido sigue actualizándose.
8. Lanzar `/spawn … :: FAKE_SLEEP` (o un worker lento) y usar cancelar en Zed; la respuesta del turno debe ser `stopReason: cancelled`.

## Fuera de alcance (intencional)

- Sin orquestador LLM en el adaptador (solo parser de comandos).
- Sin autenticación ACP (`authMethods` vacío).
- Sin `session/load`, persistencia de sesión ni balanceo entre procesos.
- Sin métodos de cliente `fs/*` ni `terminal/*` (solo notificaciones agente → cliente).
- `mcpServers` en `session/new` se acepta y se ignora.
- Sin candado entre procesos en `agent.json` (lectura/escritura como el resto del proyecto).
- Las notificaciones `notifications/progress` del camino MCP no llegan a Zed porque Zed no envía `progressToken`.

## Riesgos conocidos

- **agent.json sin lock**: varios lectores pueden ver estados intermedios; un runner tardío no debería pisar `stopped` (lógica existente en `updateAgent`).
- **Progreso MCP vs ACP**: este spike hace polling de `progress.log` y `stdout.log`, no el stream MCP en tiempo real.
- **Cancelación**: depende de `closeAgent` / señales al runner; workers que ignoren SIGTERM pueden tardar hasta SIGKILL.

## Arquitectura mínima

```
Zed (stdio) → scripts/acp.mjs → src/acp/hub.mjs → engine ACP hijo (stdio)
                    ↓ /spawn, /board
              spawnAgent / followAgent → workers CLI (.zedpstack/agents/<id>/)
```
