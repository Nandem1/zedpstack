# Review request — zedpstack v0.4.0

## Scope

Read-only review of `/Users/nndsk/Projects/zedpstack` at tag **v0.4.0** (commit on main).

Focus:

1. **setup-zedpstack** — `src/modelSheet.mjs`, `src/setupConfig.mjs`, `dispatch setup`, alignment with pstack `setup-pstack` sheet format
2. **Streaming** — `EventSink`, `--tee-events`, `dispatch watch`, `docs/STREAMING.md`
3. **Playbooks** — multimodel roles (interrogate a/b/c, architect runners, reflect lenses); `config.mjs` aliases
4. **Gaps vs “pstack completo”** — read-only boundary, effort field unused in CLI, sequential vs fan-out
5. **Correctness** — edge cases in sheet parse, watch tail, security (read-only enforcement)

## Output format

## Verdict
GO / NO-GO / GO-with-fixes (one line)

## Strengths
3 bullets

## Issues
| Severity | Area | Finding | Suggestion |

## Missing for production `/zedpstack` + `/setup-zedpstack`
3 bullets max

Do not modify files. Cite paths and line ranges where possible.
