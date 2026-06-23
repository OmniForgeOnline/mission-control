---
name: frontend-qa
description: Visual and interaction QA for UI changes before review.
---

# Frontend QA

## When to use

After implementing a UI change and before mechanical checks or code review. Use when layout, responsiveness, accessibility, or interaction polish matters.

## How

The harness attaches **Workspace artifacts** (changed files, diff stat, excerpts) before your turn. Start there when identifying what changed.

1. Identify what changed: components, routes, states (loading, empty, error).
2. Verify happy path: primary user flow works end-to-end.
3. Check responsive breakpoints if the change touches layout.
4. Spot-check accessibility: focus order, labels, contrast, keyboard navigation.
5. Compare against the UX scope from prior steps; note gaps explicitly.
6. Fix small issues in-place if trivial; otherwise list them for the implement step.

Report findings in your final message:
- **Verified** — what you checked and result
- **Issues** — numbered list with severity (blocker / minor)
- **Screens** — pages or components exercised

## Anti-patterns

- Approving UI without loading the affected views.
- Only testing desktop layout.
- Treating pixel-perfect as required when the task is functional.
- Large redesigns during QA instead of filing follow-ups.

## Programmatic surface

- `read_run(runId, "summary.md")` — what the implement step claimed changed.
- `tech_debt_capture(...)` — visual debt or a11y follow-ups out of scope.