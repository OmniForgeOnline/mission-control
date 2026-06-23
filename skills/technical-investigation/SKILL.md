---
name: technical-investigation
description: Explore the codebase and architecture to produce an actionable technical plan.
---

# Technical Investigation

## When to use

Before implementing a feature, bugfix, infra change, or SEO remediation. Use when you need to understand where code lives, what will break, and how to sequence work.

## How

1. Read the task description and any plan from prior conversation steps.
2. Search the workspace: grep for symbols, read entry points, trace call paths.
3. Identify touch points: files, APIs, config, tests, migrations.
4. List risks: regressions, missing tests, backward compatibility, rollout order.
5. Produce a plan with ordered steps, each small enough to verify independently.

For conversation steps, wrap the final plan in `<proposed_plan>`. For agent turns, use markdown headings: Approach, Files, Risks, Verification.

## Anti-patterns

- Planning from memory instead of reading the repo.
- Giant refactors when a surgical change suffices.
- Skipping test impact analysis.
- Proposing changes to files you have not opened.

## Programmatic surface

- `gbrain_search(query)` — prior architecture decisions.
- `read_run(runId, "log.txt")` — what a previous agent already tried.
- `tech_debt_capture(...)` — file follow-ups discovered during investigation.