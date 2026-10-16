# zedpstack

Orquestación portable multi-runtime sobre playbooks inspirados en pstack.

> **The LLM decides; the dispatcher executes.**

- `SKILL.md` — juicio del orquestador (routing, síntesis, judgment).
- `scripts/dispatch.mjs` — mecánica determinista (spawn, manifest, eventos, validación).

## Instalación

```bash
git clone https://github.com/nndsk/zedpstack.git
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

```bash
node /path/to/zedpstack/scripts/dispatch.mjs run \
  --playbook architecture-review \
  --goal "Revisar arquitectura frontend MH-Next"
```

Estado en `.zedpstack/runs/<runId>/`.

## Licencia

MIT — ver `LICENSE`. Contenido upstream de pstack no está vendoreado; ver `docs/UPSTREAM.md`.
