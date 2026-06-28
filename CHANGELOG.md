# Changelog

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
