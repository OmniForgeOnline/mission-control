---
name: content-production
description: Scope, outline, and draft documents, specs, blog posts, and support copy.
---

# Content Production

## When to use

Writing or updating prose deliverables: docs, specs, blog posts, marketing copy, postmortems, support responses. Use for scope, outline, and draft workflow steps.

## How

**Scope / outline (conversation):**
- Clarify audience, tone, length, and distribution channel.
- Ask one blocking question per turn when needed.
- Emit `<proposed_plan>` with title, audience, outline sections, and key messages.

**Draft (agent turn):**
- Follow the approved outline; do not silently expand scope.
- Use clear headings, short paragraphs, and concrete examples.
- For repo docs: place files in the correct paths and match existing style.
- For external-facing copy: mark anything needing operator approval before publish.

## Anti-patterns

- Wall-of-text drafts without structure.
- Publishing or sending customer-facing content without approval on gated steps.
- Inventing product facts not supported by task context or memory.
- Copy-pasting generic filler instead of task-specific detail.

## Programmatic surface

- `gbrain_search(query)` — brand voice, prior docs, product facts.
- `propose_rule` / `gbrain_propose` — durable style guides (via `proposal-first`).