# zedpstack

Orquestación portable: **playbooks pstack** (how, Investigation, …) ejecutados con Claude/Codex CLI.

> **The LLM decides; the dispatcher executes.**

- `SKILL.md` — juicio del orquestador (routing, síntesis, judgment).
- `scripts/dispatch.mjs` — mecánica determinista (spawn, manifest, eventos, validación).

## Instalación

```bash
git clone https://github.com/Nandem1/zedpstack.git
cd zedpstack
cp zedpstack.config.example.json zedpstack.config.json
# editar modelos según tu cuenta (archivo local, no se commitea)
npm test
```

En Zed/Cursor, symlink de skill (playbooks/config se resuelven desde la ruta real del paquete):

```bash
ln -sfn "$(pwd)" ~/.agents/skills/zedpstack
```

Opcional: `export ZEDPSTACK_ROOT=/ruta/al/clon` si necesitas forzar otra raíz que no sea la del código instalado.

## Uso

Desde la raíz del repositorio bajo revisión:

Requiere [pstack-claude](https://github.com/) instalado en Codex (o `PSTACK_ROOT`). Ver [docs/PSTACK_ADAPTER.md](./docs/PSTACK_ADAPTER.md).

```bash
node ~/Projects/zedpstack/scripts/dispatch.mjs run \
  --playbook how-investigation \
  --goal "¿Cómo funciona el gate de sesión en este repo?" \
  --repo /path/to/repo
```

Estado en `.zedpstack/runs/<runId>/`.

## Licencia

MIT — ver `LICENSE`. Contenido upstream de pstack no está vendoreado; ver `docs/UPSTREAM.md`.
