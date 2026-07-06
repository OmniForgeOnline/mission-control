---
"@omniforge/mission-control": minor
---

Project paths are now repointable, and the merge-status sweep resolves from the stored PR URL instead of the local checkout.

- `PATCH /api/projects/:id` accepts `repoPath` and cascades the change onto the project's existing tasks (`repoPath` + `targets`), keyed by `projectId`. Settings exposes a per-project Repoint action via the folder picker.
- `getMergeRequestState` derives the PR identity from the stored merge-request URL first, with the local checkout as fallback, so a moved repo no longer reports `unknown`.
- Merge-status failures now surface a reason (no git remote, host mismatch, missing auth, forge API error, network error) instead of a bare `unknown`.
