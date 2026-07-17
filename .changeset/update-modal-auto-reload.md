---
"@omniforge/mission-control": patch
---

Fix update modal auto-recovery: after "Update now" the modal now polls until the server restarts and reloads the page automatically, instead of sitting on a "Restarting..." message that required a manual refresh.
