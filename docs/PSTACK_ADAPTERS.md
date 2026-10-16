# Catálogo de adaptadores pstack (v0.3)

| Playbook | Skill pstack | Pasos (secuencial) | Contexto extra |
|----------|--------------|--------------------|----------------|
| `how-investigation` | how + investigation | explore → synthesize | — |
| `why-rationale` | why | investigate → synthesize | opcional en `--goal` |
| `architect-sketch` | architect (+ how ground) | ground → sketch-a/b → synthesize | — |
| `interrogate-review` | interrogate | review-a/b/c → lead | `--context-file` diff o archivos |
| `reflect-session` | reflect | 3 reviewers → synthesize | `--context-file` digest transcript |

No adaptados (siguen en pstack nativo / futuro): swarm, arena fan-out paralelo, feature, bug-fix (escritura), babysit, shipping.

Paralelismo pstack se modela como **pasos secuenciales** con el mismo prompt y distinto `promptMeta` (reviewer A/B/C, candidatos A/B).
