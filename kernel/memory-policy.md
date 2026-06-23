# Memory Policy

The harness has one durable memory store: `data/memory/pages/`. Generated indexes live under `data/state/memory-index/`. The agent-callable surface is the `gbrain` MCP server.

## Rules

- Search memory before relying on training data when prior preferences, decisions, projects, or entities might apply.
- `data/memory/pages/` is personal and gitignored — it never goes through task tickets, worktrees, or PRs.
- The harness auto-captures durable wiki pages from operator corrections, explicit agent lessons, project/task context, and completed outcomes. Agents may also write memory directly with `gbrain_propose` when they articulate something new during a turn.
- Promote a memory only when it is repeatable, generalizable, stable, and time-saving. Raw observations stay in run artifacts.

## Lookup chain

1. `gbrain_search(query)` — most precise, fastest.
2. `gbrain_index_search(query)` — wider net (artifacts + proposals).
3. External sources only when the harness has nothing relevant.
