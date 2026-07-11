---
"@omniforge/mission-control": minor
---

Per-step model selection, configurable model lists, and clearer agent failure reporting.

- **Per-step model:** pin a specific model for any workflow step, or leave it on Default. Default now means "run the tool with whatever model it is currently configured against" — mission-control no longer forces a model by default, so tools pointed at a custom provider (e.g. claude on a z.ai-compatible endpoint) are not overridden with an invalid model.
- **Settings > Agents:** add and remove models per tool. Model ids are slugified into pool ids while the exact id is passed to `--model`, so ids like `glm-5.2[1m]` work.
- **codex discovery:** a "Discover models" action calls `codex app-server model/list` and seeds codex's real account models instead of hardcoding ids.
- **Default model lists** seeded per tool (Anthropic set for claude and kiro, grok coding set), each with a no-arg default plus named models.
- **Routing fix:** the runner now uses the exact pool the router chose (no-arg default or an explicit pin) instead of re-optimizing, so the launched command matches the routing decision (and pins take effect).
- **Failure reporting:** codex `turn.failed` / `type:error` and grok `type:error` events are surfaced as the blocked reason instead of the generic "exited with code 1".
