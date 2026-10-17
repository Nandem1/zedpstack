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

Sin MCP, los mismos comandos existen en la CLI: `node scripts/dispatch.mjs agent spawn|wait|status|result|apply|close|list` (salida JSON).

## Modelos

`~/.zedpstack/pstack-models.md` usa las mismas filas de rol que `/setup-pstack`, pero cada valor es un slug que un CLI puede lanzar:

```
how explorer: haiku
architect runners: gpt-6.1-sol, opus
interrogate reviewers: opus, gpt-6.1-sol, composer-2.5
```

El runtime se deduce del slug. Para forzarlo, usa un prefijo: `cursor:claude-opus-5-5`. La hoja del host (por ejemplo `~/.cursor/rules/pstack-models.mdc`) nunca se usa para los workers.

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
