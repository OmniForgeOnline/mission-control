# Harness Skills

Skills are small, focused playbooks the harness exposes to agents. They are *not* inlined into every prompt; the agent gets a name + description index, and loads bodies on demand via the `read_skill` MCP tool.

## Schema

Every `skills/<name>/SKILL.md` must start with frontmatter:

```yaml
---
name: <lowercase-dash-name>
description: <one sentence>
---
```

Body sections (in order) — keep the file under ~80 lines:

- `## When to use` — the trigger; one paragraph.
- `## How` — concrete steps the agent should take.
- `## Anti-patterns` — what *not* to do.
- `## Programmatic surface` — MCP tools or files this skill points at, with one-line descriptions.

## Authoring

To add a new skill, file a `propose_skill` proposal — never edit `skills/` directly. See `harness-skill-author` for the contract.
