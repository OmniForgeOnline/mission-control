---
"@omniforge/mission-control": patch
---

Replace not-found string matching in detached-turn cleanup with typed errors.

- Introduces `EntityNotFoundError` (`src/core/tasks/errors.ts`), thrown by the task/run store instead of `new Error("... not found: ...")`. It carries `kind: "task" | "run"` and `id` and keeps `.message` byte-identical, so existing `.message` readers and tests are unaffected.
- The detached-turn cleanup in `src/daemon/agent-turn.ts` now swallows these via `instanceof EntityNotFoundError` instead of comparing `updateErr.message` strings, so a future wording change can no longer silently re-enable the crash that `0ca3b1e` suppressed.
- Converts all task/run not-found throw sites in the store layer (`runs.ts`, `tasks.ts`, `repo-binding.ts`, `workflow-revert.ts`) and the `read_task` MCP tool for consistency. HTTP route 404 response strings are unchanged.
