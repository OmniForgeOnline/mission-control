---
name: proposal-first
description: Promote durable harness knowledge. Repo-backed changes use propose_* tickets; personal memory writes locally.
---

# Proposal First

## When to use

You learned something the harness should remember or change.

## How

Pick the right tool for the kind of change.

| Need | Tool | Notes |
|---|---|---|
| Durable fact, preference, decision, project, entity | `gbrain_propose({slug, title, content, type, tags?, rationale})` | Writes directly to gitignored `data/memory/pages/`. No task, worktree, or PR. |
| New or changed kernel rule | `propose_rule({targetPath, title, rationale, content})` | `targetPath` like `kernel/operating-principles.md`. Creates a normal task ticket. |
| New skill | `propose_skill({name, description, body, rationale})` | See `harness-skill-author`. Creates a normal task ticket. |
| Runtime hook (on_turn_start, etc.) | Edit `.harness/hooks.yml` directly in the workspace | No proposal needed; hooks are versioned workspace config. |
| Hook proposal (archival/design doc) | `propose_hook({targetPath, title, rationale, content})` | Only for design docs in `hooks/`, not runtime config. |

Optional on repo-backed proposal calls: `workflowId` (e.g. `docs-update`, `code-feature`) — same as operator intake.

Promote only when the lesson is **repeatable, generalizable, stable, and time-saving**. If you wouldn't expect to use it again, leave the observation in the run log instead.

A filing must include:
- Concrete content (not "we should think about X").
- A rationale that explains why this belongs in *durable* harness knowledge.
- A targetPath that's safely under the harness root (the API enforces this for repo-backed proposals).

## Anti-patterns

- Editing `kernel/` or `skills/` directly. Even with file write access, don't.
- Routing personal memory through `propose_rule` or other task tickets.
- Editing `.harness/hooks.yml` through proposals instead of directly. Runtime hooks are workspace config; commit them normally.
- Proposing a memory page for a task-specific observation. Run logs are for that.
- Proposing without rationale. Operators reject those.
- Proposing the same repo-backed change across multiple tasks instead of opening one and waiting for approval.

## Programmatic surface

- `gbrain_search(query)` — check whether the lesson already exists.
- `gbrain_list(prefix)` — see existing memory under a slug prefix before adding a new one.
- `list_skills()` and `read_skill(name)` — see whether a similar skill already covers this.
- `kernel_read(section)` — read the canonical kernel before proposing a rule change.
- `list_tasks()` — see pending harness change tickets (repo-backed changes only).