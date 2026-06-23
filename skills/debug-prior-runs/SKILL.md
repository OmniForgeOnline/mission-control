---
name: debug-prior-runs
description: Inspect past runs and MCP audit logs when picking up a stalled or blocked task.
---

# Debug Prior Runs

## When to use

The task already has `turnCount > 0`, ended in `blocked` or `awaiting_operator`, or you need to know what previous agents tried.

## How

1. `read_task(id)` — full record including `pushedAt`, `mergeRequest`, `workflowRun.currentStepId`, and messages.
2. `list_runs(taskId)` — see every run for the task, newest first.
3. `read_run(runId, "prompt.md")` — the prompt the agent saw.
4. `read_run(runId, "log.txt")` — full stdout/stderr.
5. `read_run(runId, "summary.md")` — the agent's final message.
6. For deep debugging, MCP audit logs live at `data/state/mcp-audit/<runId>.jsonl` — readable from `cwd` only when the workspace is the harness root.

### Stuck post-push checklist

When `task.pushedAt` is set but `workflowRun.currentStepId` is still `implement` or `checks`:

| Signal | Likely cause |
|---|---|
| System message confirms harness push but step unchanged | Post-turn advancement failed; daemon may need restart after workflow-engine deploy |
| Operator message "raise the PR" followed by another implement turn | Message routing re-ran author step instead of advancing `checks → create_merge_request → review` |
| Agent handoff asks operator to open PR/MR | Stale guidance — harness opens review requests via `create_merge_request` step only |

Actions:
- Do not run `gh`/`glab` or forge APIs to create/check PRs.
- Hand off normally; file `tech_debt_capture` with task id, branch, `pushedAt`, and `currentStepId` if you believe advancement is broken.
- See memory page `decisions/post-push-workflow-stuck` for what autonomy jobs actually exist.

## Anti-patterns

- Re-doing the work blindly. Read at least the latest `summary.md` first.
- Fixing only the symptom from the most recent run. Cross-reference older runs to find the recurring root cause.
- Editing run artifacts. They are append-only history.
- Referencing `workflow-reconcile-sweep` — that job does not exist in `src/autonomy/registry.ts`.

## Programmatic surface

- `read_task(id)`, `list_runs(taskId, limit?)`, `read_run(runId, file)` where file ∈ {prompt.md, log.txt, summary.md}.
- `tech_debt_capture(...)` — queue follow-up implementation when workflow advancement is broken.

## Links

- none
