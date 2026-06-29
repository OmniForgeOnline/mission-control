---
"@omniforge/mission-control": minor
---

Graceful shutdown via two independent entry points.

- CLI: `mission-control stop` asks the running server to shut down (`POST /api/shutdown`), reading its pid/port from a runtime state file. Reports clear outcomes for stopped, not-running, and unreachable states, and cleans up stale state from a crashed server.
- UI: a Shut down Mission Control control under System → Maintenance → Power, gated behind a confirmation modal that warns all running processes will be terminated and the UI will be unavailable until a terminal restart.
- Shared graceful path: every entry point (Ctrl+C, UI button, `mission-control stop`) terminates all in-flight agent processes, stops the daemon, closes the HTTP server, then exits.
