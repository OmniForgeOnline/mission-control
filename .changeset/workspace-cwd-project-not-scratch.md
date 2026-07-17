---
"@omniforge/mission-control": patch
---

Fix plan/conversation workspace cwd: agents (interactive and headless) start in the project directory instead of Application Support scratch.

- Non-mutating steps use the destination project path so agents can inspect the real codebase.
- Isolated harness worktrees still apply only to repo-changing steps (implement, review, MR, conflicts).
- Scratch remains only when a task has no project target.
- Push-flow heuristics require a harness worktree branch so plan turns on the main checkout never look like a completed author push.
