# main-to-v2-sync

A **private, repository-local** facet. It packages this repository's `main` → `v2/main` forward-port
workflow as a VIPER plan and exposes it as a single command.

It is not published to the facet registry and is not intended to be. It lives in `facets/` and is
installed from that path.

## Requirements

The `viper-plans` facet must be installed in this project. This facet reuses that installation — it
declares no MCP server of its own.

## Install

From the repository root:

```sh
facet add ./facets/main-to-v2-sync
```

## Use

```
/sync-main
```

The command prepares and verifies a local `v2/sync/main` branch that merges `origin/main` into
`origin/v2/main`, following [`RELEASING.md`](../../RELEASING.md). It stops there. Pushing the branch
or opening a pull request happens only if you approve it at the plan's own gate, and the plan never
merges a pull request or publishes a package.

## Layout

| Path | Role |
|---|---|
| `skills/sync-main-to-v2/references/plan.md` | The canonical VIPER plan — the source of truth for the workflow |
| `skills/sync-main-to-v2/SKILL.md` | How to materialize and execute that plan |
| `commands/sync-main.md` | The `/sync-main` entry point |

`.opencode/plans/main-to-v2-sync/plan.md` is a **generated** copy written at run time. Edit the
canonical companion instead; the runtime copy is overwritten on every invocation.
