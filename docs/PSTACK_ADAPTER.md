# Adaptador pstack

zedpstack **no copia** skills de pstack al repo. En runtime:

1. `resolvePstackInstall()` — `PSTACK_ROOT` o última versión en `~/.codex/plugins/cache/pstack-claude/pstack/`.
2. Playbook `how-investigation` — prompts desde `how/references/explorer-prompt.md` y `explainer-prompt.md`.
3. Orquestador (SKILL) — routing según `poteto-mode` (Investigation → how).

`architecture-review` es alias deprecado de `how-investigation`.

Requisito: plugin **pstack-claude** instalado en Codex (o `PSTACK_ROOT` apuntando a una copia con `skills/`).
