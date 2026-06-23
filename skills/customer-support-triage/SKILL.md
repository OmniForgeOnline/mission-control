---
name: customer-support-triage
description: Classify support tickets and draft accurate, empathetic responses.
---

# Customer Support Triage

## When to use

Customer support workflow steps: triage conversations and draft_response agent turns. Use when turning a user issue into a classified, actionable response.

## How

**Triage (conversation):**
- Capture: who, product area, symptoms, urgency, prior contact.
- Classify: bug / how-to / billing / feature request / incident.
- Ask one blocking question per turn until classification is confident.
- Emit `<proposed_plan>` with category, summary, and proposed resolution path.

**Draft response (agent turn, approval required):**
- Lead with empathy; acknowledge the issue in one sentence.
- State what you found (or what you need) clearly.
- Provide numbered steps or a direct answer — no jargon.
- Set expectations: timeline, escalation, or follow-up needed.
- Never send externally without operator approval on this step.

## Anti-patterns

- Promising refunds, credits, or SLA commitments without authority.
- Blaming the customer or being defensive.
- Generic copy-paste replies that ignore the specific ticket.
- Sharing internal-only debugging detail in customer-facing drafts.

## Programmatic surface

- `gbrain_search(query)` — known issues, FAQs, product policies.
- `read_task(id)` — full ticket thread and operator context.