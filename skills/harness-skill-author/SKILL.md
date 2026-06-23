---
name: harness-skill-author
description: Author a new skill via propose_skill. Enforces the standard structure.
---

# Harness Skill Author

## When to use

You see a recurring pattern across multiple tasks that deserves a skill. The bar is the same as a memory: repeatable, generalizable, stable, time-saving.

## How

1. Search first: `list_skills()` and `read_skill(name)` for nearby skills. If one already covers this, propose an edit instead of a new file.
2. Pick a `name` (lowercase-dash, e.g. `database-migrations`).
3. Draft a body with the four standard sections in order:
   - `## When to use` — the trigger.
   - `## How` — concrete steps.
   - `## Anti-patterns` — what not to do.
   - `## Programmatic surface` — MCP tools the skill points at.
4. Keep the body under ~80 lines. Skills are read on demand; long ones get skipped.
5. File the proposal:

```
propose_skill({
  name: "<lowercase-dash>",
  description: "<one sentence used in the index>",
  body: "<full markdown body, the four sections>",
  rationale: "<why this is durable harness knowledge>"
})
```

The harness adds the frontmatter; you write the body.

## Anti-patterns

- Free-form structure. Stick to the four sections.
- Stuffing implementation details. Skills are playbooks, not code.
- Inlining tool schemas. Reference tools by name; their schemas live in the MCP server.
- Editing `skills/` directly. Even when you can.

## Programmatic surface

- `list_skills()`, `read_skill(name)`, `propose_skill({name, description, body, rationale})`.
