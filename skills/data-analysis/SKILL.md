---
name: data-analysis
description: Frame questions, collect evidence, analyze data, and recommend actions.
---

# Data Analysis

## When to use

Data-analysis, ux-research synthesis, and seo-investigation evidence steps. Use when the task needs numbers, trends, or structured findings instead of code changes.

## How

1. **Frame** — restate the question, null hypothesis, and what decision the analysis supports.
2. **Collect** — identify data sources: logs, exports, APIs, analytics, spreadsheets. Note freshness and gaps.
3. **Analyze** — show methodology briefly; use tables or bullet summaries, not raw dumps.
4. **Recommend** — tie findings to concrete next steps with confidence level (high / medium / low).

Conversation steps: emit `<proposed_plan>` when the question is fully framed. Agent turns: end with **Findings**, **Caveats**, **Recommendation**.

## Anti-patterns

- Analysis without stating assumptions or data limitations.
- Cherry-picking data to support a predetermined conclusion.
- Presenting correlation as causation.
- Huge unformatted data paste instead of summarized insights.

## Programmatic surface

- `read_run(runId, "log.txt")` — prior collection attempts.
- `gbrain_search(query)` — prior metrics definitions or dashboards.
- `content-production` skill — turn recommendations into a written report.