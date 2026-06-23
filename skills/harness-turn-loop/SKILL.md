---
name: harness-turn-loop
description: Map of the per-turn loop. Loads other skills on demand instead of inlining everything.
---

# Harness Turn Loop

## When to use

First skill to consult on any task. It tells you which other skill applies to the situation in front of you.

## How

The harness has prepared:
- A workspace cwd (a git worktree on a `harness/<id>` branch if the destination is a repo).
- An MCP server `gbrain` with read/write tools for memory, proposals, runs, tasks, kernel, skills, quality grades, and the tech-debt ledger.
- Mechanical checks (if `.harness/checks.yml` exists in the workspace) that gate your push.
- A reviewer agent that runs after every push.

Your loop:

1. **Orient.** Read the task and operator notes. If you've been here before (`turnNumber > 1`), skim the latest operator message only.
2. **Read recalled memory.** Check the `## Recalled memory (harness wiki)` block in your prompt first, then `gbrain_search(<keywords>)` if you need more.
3. **Pick a skill.** Use the matrix below; load the body with `read_skill(<name>)` before acting.
4. **Execute and verify.** Stay inside the workspace cwd.
5. **Hand off.** Write a `operator-handoff`-shaped final message.

| Situation | Skill |
|---|---|
| Task targets a git repo, you'll change code | `pr-driven-execution` |
| You're a reviewer, the author already pushed | `code-review` |
| You learned something durable | `proposal-first` |
| You found debt you can't fix this turn | `tech-debt-capture` |
| Mechanical checks failed and the harness re-prompted you | `harness-checks` |
| You need to look up grades or pick where to push | `harness-quality` |
| You're picking up a stalled task | `debug-prior-runs` |
| You need to add or change a skill | `harness-skill-author` |
| You're writing your final message | `operator-handoff` |

## Anti-patterns

- Inlining every skill body in your reasoning. Use `read_skill` only for the one(s) you need.
- Creating or checking PRs/MRs yourself (`gh`, `glab`, forge APIs, or curl). The harness workflow opens them after push via the `create_merge_request` step — agents only implement, verify, and hand off.
- Writing memory or tech-debt directly on disk. Use `gbrain_propose` (local memory) or `tech_debt_capture` instead.
- Editing kernel/skills/hooks directly. Use `propose_*` tickets for repo-backed changes.

## Programmatic surface

- `list_skills()` — see what's available.
- `read_skill(name)` — load a skill body.
- `kernel_read(section?)` — load kernel sections.
- `gbrain_search(query)`, `list_tasks()`, `list_runs()` — orient yourself.
