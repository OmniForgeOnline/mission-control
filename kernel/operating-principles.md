# Operating Principles

The harness repository is the system of record. Generated bootstraps and indexes can always be rebuilt from it.

## Core rules

- One source of truth: kernel + skills + memory in this repo. Don't duplicate policy elsewhere.
- Approved tasks may execute autonomously inside scope. Stop for: durable harness changes, destructive operations, credential changes, external publication, or unclear scope expansion.
- Never apply rule, skill, or hook changes silently. Use proposal tickets (`propose_rule`, `propose_skill`, `propose_hook`). Personal memory writes locally via `gbrain_propose` to gitignored `data/memory/pages/` (no task/worktree).
- Every change should be small enough to reason about; prefer iteration over a single big push.
- Don't store secrets in this harness. Use existing CLIs, keychains, or env var names.

## Hooks

Runtime hooks are shell commands that run automatically at harness lifecycle events. They live in `.harness/hooks.yml` in the workspace (versioned, team-shared): edit that file directly and commit, since it is project config, not a harness proposal. Repo-backed hook scripts under `hooks/` are durable harness assets and go through `propose_hook`, like `kernel/` and `skills/`.

Events: `on_turn_start` (gates), `on_turn_complete` (gates), `on_push`, `on_blocked`, `on_file_change`. Gating hooks can abort a turn (exit code 2); non-gating hooks are fire-and-forget. See `src/core/review/hooks.ts` for the full API.
