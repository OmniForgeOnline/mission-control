---
"@omniforge/mission-control": patch
---

Fix `mission-control stop` stranding a live server after a failed second start.

A second `mission-control` started while the first already owned the port could
overwrite the live server's pid/token in `server.json` before its own bind error
(EADDRINUSE) terminated it. `stop` then read the dead second pid, treated the
file as stale, and could no longer reach the real running server. The server now
awaits a successful bind before starting the daemon or recording control info, so
a startup that fails to claim the port aborts without touching `server.json`.
