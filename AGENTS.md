# AGENTS.md

Machine-readable constraints for agents editing this repository. Do not restate lint, types, or directory layout.

## MUST

- Split any `src/` file approaching 500 lines before adding logic.
- In tests: `mkdtemp` + `ensureHarnessRepository(root)`; never use ambient `HARNESS_ROOT`.
- Satisfy quality gate with test **path** matching domain (`tests/<domain>.test.ts` or path contains `<domain>`). Imports alone do not count.
- File harness policy changes via `propose_rule` / `propose_skill` MCP tools.
- Write durable memory via `gbrain_propose`, not filesystem edits under `data/memory/`.
- Reuse `runAutonomyAgentTurn` for agent-based autonomy jobs (`src/autonomy/agent-run.ts`).
- Register new autonomy jobs: `src/autonomy/handlers/<name>.ts` + `src/autonomy/registry.ts`.
- Register new MCP tools: `src/mcp/tools/<name>.ts` + `src/mcp/tool-registry.ts`.

## MUST NOT

- Create PRs/MRs via `gh`, `glab`, or forge APIs. Only workflow step `create_merge_request` opens them.
- Edit `kernel/` or `skills/` in place.
- File `propose_*` when `findActiveProposalTask` would match same `kind` + `targetPath`.

## INFERENCE TRAPS

- `HARNESS_ROOT` holds runtime state (tasks, settings, workflows, seeded kernel/skills). Defaults to a platform-standard dir outside any checkout (`~/Library/Application Support/mission-control` on macOS, `$XDG_DATA_HOME/mission-control` on Linux, `%APPDATA%\mission-control` on Windows).
- After confirmed push on repo-modifying author step: daemon advances `checks` → `create_merge_request` → `review` without operator action. Missing final-answer markers ≠ blocked workflow.
