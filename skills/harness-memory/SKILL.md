---
name: harness-memory
description: Search, read, and propose durable harness memory through the gbrain MCP server.
---

# Harness Memory (gbrain)

## When to use

Whenever prior preferences, decisions, projects, or entity context might apply. Always before relying on training data for things specific to this user/repo/team.

The harness also **auto-recalls** matching wiki pages into task prompts from `data/memory/pages/`. Check the `## Recalled memory (harness wiki)` section first; use MCP tools when you need pages the harness did not surface or want a wider search.

## How

1. Read any `## Recalled memory` block already injected into your prompt.
2. Start with the most precise tool: `gbrain_search(<keywords>)`. Wrap in a couple synonyms if the first hit is empty.
2. If the answer might be in run logs or proposals (not just memory pages), use `gbrain_index_search`.
3. To read a specific page: `gbrain_read(slug)`.
4. To enumerate everything under an area: `gbrain_list(prefix="<area>/")`.
5. To capture something durable: the harness auto-writes lessons, operator corrections, project context, and completion summaries. Use the Memory UI for manual pages, or `gbrain_propose(...)` to write directly to gitignored `data/memory/pages/` (no task queue or worktree).

## Examples

```
gbrain_search("python testing preferences")
→ [{slug: "preferences/python-testing", title: "Python testing prefs", score: 3, snippet: "..."}]

gbrain_read("preferences/python-testing")
→ full page content

gbrain_propose({
  slug: "decisions/branch-naming",
  title: "Harness branch naming",
  type: "decision",
  tags: ["git", "harness"],
  content: "All harness-driven branches use the prefix `harness/<short-id>` ...",
  rationale: "Pattern is now repeated across worktree, PR, and review code paths."
})
→ { slug: "decisions/branch-naming", status: "approved", captured: true, targetPath: "data/memory/pages/decisions/branch-naming.md" }
```

## Anti-patterns

- Routing personal memory through `propose_rule` / task tickets. Memory is local-only via `gbrain_propose` or auto-capture.
- Proposing memory for a one-off observation. Use the run log.
- Treating gbrain as a chat scratchpad. It's durable knowledge only.

## Programmatic surface

- `gbrain_search(query, limit?)`, `gbrain_index_search(query)`, `gbrain_read(slug)`, `gbrain_list(prefix?, limit?)`, `gbrain_propose({slug, title, content, type?, tags?, rationale})`.
