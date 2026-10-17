# zedpstack

Ejecuta pstack (poteto-mode) en Claude Code, Codex, Cursor o Zed. El chat del host es el orquestador: lee poteto-mode, elige el playbook y, cuando pstack pide un subagente, llama a las herramientas MCP de zedpstack. Cada worker corre como `claude -p`, `codex exec` o `agent -p` según la hoja de modelos en `~/.zedpstack/pstack-models.md`.

## Instalación

Requisitos: Node ≥ 20, pstack instalado (plugin de Codex o Claude Code, o `PSTACK_ROOT`) y al menos uno de `claude`, `codex` o `agent`.

```bash
git clone https://github.com/Nandem1/zedpstack.git
cd zedpstack
npm test
node scripts/dispatch.mjs install            # vista previa
node scripts/dispatch.mjs install --apply    # registra MCP y skills
node scripts/dispatch.mjs doctor --human
```

`install --apply` registra el servidor MCP (`scripts/mcp.mjs`) y enlaza los skills `zedpstack`, `setup-zedpstack` y `zedpstack-bitacora`. En Zed imprime el bloque `context_servers` para pegarlo en settings. Reinicia el host después.

## Uso en el chat

- `/zedpstack <tarea>` en Claude Code o Codex, o el prompt MCP equivalente en Cursor.
- `/setup-zedpstack` para elegir modelos por rol (misma hoja que `/setup-pstack`).

El orquestador delega con `spawn_agent`, espera con `wait_agent` y trae commits de writers con `apply_agent_changes`. Sin MCP, la misma API está en `node scripts/dispatch.mjs agent spawn|wait|status|result|apply|close|list`. `node scripts/dispatch.mjs top` muestra workers en vivo en una terminal.

## Zed

Zed arranca el hub con `scripts/acp.mjs`. Configuración de engines, comandos `/claude` y `/codex`, tarjetas de workers, permisos y cancelación están en [docs/ACP_DESIGN.md](./docs/ACP_DESIGN.md).

## Modo batch

Sin orquestador en chat:

```bash
node scripts/dispatch.mjs run --playbook how-investigation --goal "¿Cómo funciona X?" --repo /ruta --tee-events
```

Ver [docs/PSTACK_ADAPTERS.md](./docs/PSTACK_ADAPTERS.md) y [docs/STREAMING.md](./docs/STREAMING.md).

## Documentación

- [Arquitectura](./docs/ARCHITECTURE.md)
- [Diseño ACP](./docs/ACP_DESIGN.md)
- [Bitácora](./docs/BITACORA.md)
- [Incidente cerrado (alias opus)](./docs/PROBLEMAS_ACTUALES.md)
- [CHANGELOG](./CHANGELOG.md)
- [LICENSE](./LICENSE)

Skills: [zedpstack](./SKILL.md), [setup-zedpstack](./setup-zedpstack/SKILL.md), [zedpstack-bitacora](./zedpstack-bitacora/SKILL.md).
