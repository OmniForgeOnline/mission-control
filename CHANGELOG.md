# Changelog

## 0.2.0

### Minor Changes

- b4e7ff3: Add an npm update pill in the header next to the Mission Control title. It compares the installed version against the npm registry latest and renders only when behind. Clicking Update offers two modes: update now (stops active work, installs, and restarts) or update when idle (installs and restarts on the next idle transition). A detached updater performs the global install and re-launches the server, with a safe degrade so a failed install never leaves the app dead.

### Patch Changes

- 1c95439: Surface Kiro ACP rate-limit details in blocked run diagnostics instead of showing only "Internal error".

## 0.1.3

### Patch Changes

- 4837654: Intake classification reliability and failed-intake recovery.

  - Tolerant parsing: the intake classifier now accepts fenced or prose-wrapped JSON, so a model preamble no longer fails ticket creation with "Response must be a single JSON object".
  - Non-planning classifier: intake runs in a read-only `classify` mode instead of the agent's planning mode, which previously forced a planning document (the root cause of the invalid-output failures) and duplicated the workflow's own planning step. Classification drops from multi-minute planning sessions to seconds.
  - Failed-intake recovery: failed intake requests now stay visible in the project intake panel with their original text and a Retry button that re-classifies the same message in place (`POST /projects/:id/intake/queue/:itemId/retry`).

## 0.1.2

### Patch Changes

- 2111ac3: ClickUp ticket sync now retries transient transport failures (e.g. `read ETIMEDOUT`) with bounded backoff, and defers a single task whose comment fetch fails transiently to the next polling interval instead of aborting the whole autonomy tick with an unhandled `fetch failed`. Retry applies only to idempotent reads and status updates; comment creation is a single-attempt POST so a read timeout after ClickUp accepts it cannot post duplicate pickup/completion comments.
- 26c1318: Ensure timed-out review hooks terminate their full process tree instead of leaving child commands running.

All notable changes to OmniForge Mission Control are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-24

First public release.

### Added

- Local-first control panel for running AI coding agents (Claude, Codex, Grok, OpenCode, ACP) with a live multi-agent view, durable memory, and policy-enforced boundaries.
- gbrain memory MCP server: search, index, and auto-capture wiki pages, with a personal wiki layer and generated indexes.
- Autonomy jobs: tech-debt sweep, quality gates, and proposal drafting, backed by a persistent tech-debt ledger.
- GitHub and GitLab connectors for opening PRs and MRs from workflow steps.
- Cross-platform support: file-backed encrypted-at-rest secret vault off macOS, Windows-safe login-shell resolver, and a platform-standard `HARNESS_ROOT`.
- `npm start` and the `mission-control` bin work on macOS, Linux, and Windows; distributed as `@omniforge/mission-control` on npm.
- Onboarding in the README: install instructions, prerequisites, and a "Your first run" walkthrough.
- CI gate (lint, typecheck, tests, knip, build) on Ubuntu and macOS across Node 20, 22, and 24.

[0.1.1]: https://github.com/OmniForgeOnline/mission-control/releases/tag/v0.1.1
