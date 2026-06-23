---
name: pr-driven-execution
description: Branch, commit, push. The harness create_merge_request workflow step opens PRs/MRs after push — agents never use gh/glab.
---

# PR-Driven Execution

## When to use

Any task whose first target is a git repository. The harness has already set up a worktree at `cwd` on a `harness/<short-id>` branch off the destination repo's default branch.

## How

1. Implement the change inside `cwd`. Stay inside it.
2. Run any relevant project tests/lints before finishing the turn. If `.harness/checks.yml` exists, those checks will gate the harness push automatically.
3. Focus your work in the worktree. When the turn completes, the harness commits any uncommitted changes and pushes the task branch for you.
4. Do not create or verify PRs/MRs yourself. After push, the harness `create_merge_request` workflow step opens the review request and surfaces the link in the task UI.
5. Your final message must follow `operator-handoff` and name what you changed.

## Merge request content

The harness composes PR/MR titles and descriptions from your ticket and handoff. Match the standard three-section format so the generated review request is useful:

1. **Overview** — what and why (includes the harness ticket link)
2. **Key Changes** — 3–5 concise bullets from your `**Pushed.**` / `**Changed.**` handoff
3. **Impact** — user-facing or system-level effects, plus verification and residual risks when relevant

Titles use conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `perf:`, `test:`). Write handoff bullets that map cleanly to Key Changes; put verification under `**Verified.**` and risks under `**Watch.**` so they land in Impact.

## Anti-patterns

- Running `gh pr create`, `glab mr create`, or any PR/MR CLI — including `gh pr view` / `gh pr list` to check status.
- Calling forge APIs or harness connector code to open a PR/MR. That is harness-operator workflow, not agent work.
- Pushing directly to `main`/`master` or rewriting the base branch.
- `git remote add` or any change to `.git/config` outside `cwd`.
- `cd`-ing out of `cwd` to modify the destination repo's other working tree.
- Squashing your work into one giant commit when smaller ones tell a clearer story.

## Programmatic surface

- `list_runs(taskId)` and `read_run(runId, "log.txt")` — see what previous turns of this task did.
- `tech_debt_capture(...)` — file follow-up debt items you noticed but won't fix this turn.
- `gbrain_search(query)` — check for prior decisions about the area you're touching.
