---
"@omniforge/mission-control": patch
---

Catch handler throws in `runAutonomyJob` so one flaky job never aborts the daemon tick.

- `runAutonomyJob` now wraps `await handler(root)` in try/catch: a throwing handler (e.g. a transient ClickUp `fetch failed` / ETIMEDOUT) produces a blocked `AutonomyRunResult` naming the error and still records it via `updateJobRun`. The run is marked blocked and `nextRunAt` advances, instead of escaping to `tickAutonomy`'s `onError` and skipping the recording.
- Defense-in-depth in `clickup-ticket-sync`: the two previously unguarded `createClickUpComment` POST sites (pickup and completion comments) now defer transient transport failures, leaving the posted flag false so the next polling interval retries. Mirrors the existing `listClickUpTaskComments` defer pattern. `createClickUpComment` stays single-attempt to avoid duplicate comments.
