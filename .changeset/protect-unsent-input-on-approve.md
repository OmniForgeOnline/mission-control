---
"@omniforge/mission-control": patch
---

Guard against discarding unsent operator input when advancing a workflow step. Approving a step that has an unsent draft in the step conversation now prompts for confirmation before discarding it, instead of silently dropping the text.
