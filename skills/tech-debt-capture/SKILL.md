---
name: tech-debt-capture
description: Append a debt item to the harness ledger so the autonomy sweep queues a synthetic task.
---

# Tech Debt Capture

## When to use

You noticed something during a turn that's worth fixing but is out of scope right now. On the `capture_followups` workflow step, the harness pre-extracts candidates from the author's **Watch** / **Open** handoff lines and reviewer notes — your job is to confirm and file the real ones.

## How

1. Read the **Extracted candidates** section in your prompt (harness gathered these programmatically).
2. Drop noise, duplicates, and items already fixed.
3. Call `tech_debt_capture` for each real item with enough context that a future agent can act without asking you.

```
tech_debt_capture({
  title: "MCP audit log fills disk on long-running daemons",
  description: "src/mcp/gbrain-server.ts appends to runs/<runId>.jsonl forever. Add rotation when file > 10 MB or > 7 days old.",
  agent: "codex",
  targets: [{ path: "/Users/vbutacu/codex/harness/src/mcp/gbrain-server.ts", kind: "file" }]
})
```

The autonomy `tech-debt-sweep` job will queue exactly one synthetic task per open item, then mark it `queued` so it isn't re-queued.

## Anti-patterns

- Capturing things you could fix in this turn. Fix them.
- Vague titles ("clean up code", "refactor"). Future agents bounce off vague tasks.
- Capturing the same item repeatedly. Search first — autonomy de-dupes by title only loosely.

## Programmatic surface

- `tech_debt_capture({title, description, agent?, targets?})` — append.
