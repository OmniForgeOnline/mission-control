---
"@omniforge/mission-control": patch
---

Interactive implement turns auto-advance when the agent finishes so automated steps can chain.

- Authoring/implement PTY sessions auto-complete on process exit (success) or when the harness branch is committed, clean, and pushed — Done is no longer required to unlock create_merge_request / review.
- Planning/conversation stays operator-driven (Done) so questions are not skipped when the CLI exits.
- Operator can still type into the TUI anytime and use Done / Block.
- Git handoff is always checked on interactive Done for repo author steps (not only when reply text looks like a final answer).
