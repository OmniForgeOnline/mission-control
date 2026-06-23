---
name: product-discovery
description: Scope user needs, success criteria, and constraints before building or writing.
---

# Product Discovery

## When to use

Starting a feature, UX change, spec, research question, or marketing brief. Use when the task needs clarity on who, what, and why before execution.

## How

1. Identify the user or audience and the job they are trying to do.
2. Ask one blocking question per turn if scope is still fuzzy.
3. Capture success criteria: what "done" looks like, what is explicitly out of scope.
4. Note constraints: timeline, platforms, compliance, dependencies, existing decisions.
5. When scope is clear, emit a structured summary inside `<proposed_plan>` (conversation steps) or a concise scope block in your final message (agent turns).

Structure scope summaries with:
- **Problem** — one sentence on the pain or opportunity
- **Users** — who is affected
- **Success** — measurable or observable outcomes
- **Out of scope** — what you will not do this turn
- **Open questions** — only items that block execution

## Anti-patterns

- Jumping to implementation before the problem is stated.
- Asking multiple questions in one turn during conversation steps.
- Vague success criteria ("make it better", "improve UX").
- Scope creep: folding unrelated requests into the same task.

## Programmatic surface

- `gbrain_search(query)` — prior product decisions, personas, positioning.
- `read_task(id)` — full task context and operator thread.