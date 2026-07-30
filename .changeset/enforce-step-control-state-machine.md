---
"@omniforge/mission-control": patch
---

Enforce the workflow state machine on per-step controls. Approve step is disabled and rejected server-side unless the step is the active decision point and the agent is idle, so a workflow can no longer be advanced while the agent is working or by pre-approving an unreached gate. Done/Block now render only for the active step's live interactive session.
