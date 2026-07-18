---
"@omniforge/mission-control": minor
---

Move ClickUp ticket sync onto the ClickUp connector, harden mobile catalog/settings layouts, and expand agent setup (models, CLI install/login, home onboarding).

- ClickUp connect activates ticket sync; disconnect pauses it. Controls live on the connector page instead of Settings → Maintenance.
- Mobile-first catalog/settings CSS so Connectors and Autonomy stay visible and usable on small viewports; AGENTS.md frontend layout rules + overflow audit script.
- Agent settings: model pools/modal, Cursor model discovery, CLI install/login terminal, extensions modal, and home CLI onboarding checklist.
- Theme and workflow UI polish (graphite light theme, denser connector account/sync, MR chip, canvas pan/pinch).
