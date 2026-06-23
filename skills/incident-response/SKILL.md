---
name: incident-response
description: Triage, mitigate, and communicate during production incidents.
---

# Incident Response

## When to use

Active or recent production incidents: outages, elevated errors, data issues, security events. Use during intake and mitigation workflow steps.

## How

**Intake (conversation):**
- Capture severity, blast radius, start time, symptoms, and current customer impact.
- Ask one blocking question per turn until you can classify: SEV1–SEV4.
- Emit `<proposed_plan>` with immediate next actions when intake is complete.

**Mitigate (agent turn, approval required):**
- Stabilize first: rollback, feature flag, scale, cache bust, rate limit — smallest change that stops bleeding.
- Document every action with timestamp and expected effect.
- Do not root-cause during mitigation unless it is zero-risk.
- Communicate status in operator-handoff format; flag if customer comms are needed.

## Anti-patterns

- Deep debugging while users are still impacted.
- Destructive fixes without operator approval on mitigation steps.
- Silent changes with no audit trail in the task thread.
- Closing the incident without a postmortem follow-up.

## Programmatic surface

- `debug-prior-runs` skill — inspect prior agent attempts on this task.
- `read_run(runId, "log.txt")` — command output from mitigation turns.
- `gbrain_search("incident runbook")` — team-specific playbooks.