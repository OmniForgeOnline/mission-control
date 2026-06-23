---
name: operator-handoff
description: Final-message template. The reviewer agent and the operator both read this.
---

# Operator Handoff

## When to use

Every turn ends with a final message. Use this template even when the turn is short.

## How

Write five short sections, in order. Skip a section only when there's truly nothing to say.

```
**Pushed.** <branch> · <N> commit(s) · <one-line summary of what changed>

**Verified.** <what you ran, with results> — e.g. "npm test (49 pass), npm run build (clean)"

**Open.** <what's not done in this turn>

**Watch.** <residual risks, follow-up debt, anything sketchy>

**Next.** <single concrete suggestion for the operator or reviewer>
```

If the task is non-repo (no push), replace `**Pushed.**` with `**Changed.** <files touched>`.

### Post-push repo turns

When the harness commits and pushes your branch (system message confirms push):

- The daemon auto-advances `checks → create_merge_request → review` without operator input.
- Do **not** ask the operator to "raise the PR", run `gh`/`glab`, or call connector APIs.
- In `**Next.**`, say the harness will open the review request and the reviewer agent will run — e.g. "Harness will open the PR; reviewer: confirm the push."
- If you believe the workflow is stuck (`pushedAt` set but step still `implement`), hand off normally and file `tech_debt_capture` — do not bypass the workflow.

## Examples

Minimal (repo turn):

```
**Pushed.** harness/abc123def · 2 commit(s) · add quality grade MCP tool, wire reviewer prompt to it.

**Verified.** npm test (49 pass), npm run build (clean).

**Open.** None.

**Watch.** Quality grading still penalizes tests/ subdir naming heuristics; could miss edge cases.

**Next.** Harness will open the PR; reviewer: confirm coverage and naming.
```

## Anti-patterns

- "Done." without naming what was pushed/verified.
- Long prose in the body but no structured handoff. The reviewer agent parses this.
- Mixing the reviewer JSON block with the handoff. JSON only on reviewer turns; handoff only on author turns.
- Promising follow-ups in prose. Use `tech_debt_capture` so they're tracked.
- Telling the operator to create or check PRs/MRs manually after a harness push.

## Programmatic surface

- `tech_debt_capture(...)` — file the follow-ups you mention under "Watch".