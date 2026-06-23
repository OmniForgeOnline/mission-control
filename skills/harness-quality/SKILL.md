---
name: harness-quality
description: Read computed quality grades and use them to prioritize where to push.
---

# Harness Quality

## When to use

When choosing where to invest effort across multiple domains, or when reviewing a change that crosses domains.

## How

1. `quality_grades()` — get the full per-domain map. Each entry is `{grade: A..F, rationale, evidence, lastComputedAt}`.
2. `quality_grades(domain="<name>")` — focused read.
3. Lower grades have priority. The autonomy `quality-gate-sweep` job recomputes grades and queues synthetic tasks for domains below grade A.
4. When pushing a change that touches a low-grade domain, mention it in your final message and consider filing `tech_debt_capture` for follow-ups you noticed but didn't fix.

## Anti-patterns

- Treating an "A" grade as proof the domain is correct. Grades are heuristic.
- Editing `data/state/quality.json` directly. It's recomputed by the `quality-grade-update` autonomy job.
- Lowering a grade by suppressing tests. The grading penalizes that.

## Programmatic surface

- `quality_grades(domain?)` — read.
- `tech_debt_capture(...)` — file follow-ups against a low-grade domain.
