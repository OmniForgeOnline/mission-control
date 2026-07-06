---
"@omniforge/mission-control": minor
---

Agent extensions: discover, install, and inject extensions across Claude, Codex, Cursor, and Kiro.

- Discovery scans each agent's on-disk extension locations and live-merges the results with a persisted registry.
- Per-tool extensions surface in Settings > Agents and in the workflow step editor via the ExtensionPicker.
- The enabled set is injected into each agent's worktree manifest at launch.
- Install, uninstall, and discover endpoints under `/api/agent-config/extensions`.
