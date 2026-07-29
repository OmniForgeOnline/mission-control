---
"@omniforge/mission-control": patch
---

Forward the conversation plan step's plan into the implementation step's prompt. The conversation completion branch advanced on plan emission without writing the plan into `task.description` (the only channel the implement prompt reads), so conversation-based workflows (code-feature et al.) ran implementation without the plan. Now mirrors the read-only-investigation branch.
