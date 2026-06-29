---
"@omniforge/mission-control": patch
---

Intake classification reliability and failed-intake recovery.

- Tolerant parsing: the intake classifier now accepts fenced or prose-wrapped JSON, so a model preamble no longer fails ticket creation with "Response must be a single JSON object".
- Non-planning classifier: intake runs in a read-only `classify` mode instead of the agent's planning mode, which previously forced a planning document (the root cause of the invalid-output failures) and duplicated the workflow's own planning step. Classification drops from multi-minute planning sessions to seconds.
- Failed-intake recovery: failed intake requests now stay visible in the project intake panel with their original text and a Retry button that re-classifies the same message in place (`POST /projects/:id/intake/queue/:itemId/retry`).
