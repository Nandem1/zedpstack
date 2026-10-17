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
| Registro en disco | `src/agents/store.mjs` | `<repo>/.zedpstack/agents/<id>/agent.json` y logs; `.zedpstack/` se auto-ignora |
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

`spawn_agent` crea el registro, lanza `dispatch agent exec` en su propio grupo de procesos y devuelve el control al instante. El runner sobrevive a reinicios del servidor MCP o del host, y `list_agents` lo vuelve a encontrar. `close_agent` mata el grupo completo (runner y worker). Si el runner muere sin terminar, `status` lo detecta y marca el agente como `failed` (reconcile por PID).

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

## Límites conocidos

- Un CLI separado no puede heredar el modelo del orquestador (`inherit-parent`), así que corre el default de pstack y lo deja anotado.
- No se puede reanudar un agente ni mandarle mensajes; se lanza uno nuevo con el alcance consolidado (que es lo que poteto-mode recomienda de todos modos).
- El writer de Claude no tiene sandbox de SO, solo la allowlist de comandos. Si una tarea delicada necesita sandbox real, usa Codex o Cursor.
- La reenvío de context servers de Zed a los agentes ACP depende de la versión de Zed. Si no llegan, registra el MCP directamente en el host (`dispatch install`).
