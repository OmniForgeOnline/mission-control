# Changelog

## 0.5.0

### Minor Changes

- b3ec40d: Project-scoped jobs schema and migrate the harness guidance sweep out of global scope.

  - New machine-checkable schema for project-scoped jobs (`ProjectJobDefinition` + `PROJECT_JOB_JSON_SCHEMA` + `validateProjectJobDefinition`) so any user or agent can author and validate custom jobs scoped to their own project. The harness guidance sweep is the reference instance the schema is derived from.
  - Two MCP tools: `validate_project_job` (pure schema check) and `define_project_job` (validate then register for a project). Custom jobs without a built-in handler run as agent turns driven by their `instructions`.
  - The harness guidance sweep moves from a global default job to a project-scoped job owned by the harness project (the mission-control repo). It seeds only when an onboarded project's `package.json` name is `@omniforge/mission-control`, so a public install no longer spends every user's tokens improving a single repo. Roll-forward only: no backward-compatible global alias; stored globals are auto-pruned on next load.

## 0.4.1

### Patch Changes

- 1209652: Catch handler throws in `runAutonomyJob` so one flaky job never aborts the daemon tick.

  - `runAutonomyJob` now wraps `await handler(root)` in try/catch: a throwing handler (e.g. a transient ClickUp `fetch failed` / ETIMEDOUT) produces a blocked `AutonomyRunResult` naming the error and still records it via `updateJobRun`. The run is marked blocked and `nextRunAt` advances, instead of escaping to `tickAutonomy`'s `onError` and skipping the recording.
  - Defense-in-depth in `clickup-ticket-sync`: the two previously unguarded `createClickUpComment` POST sites (pickup and completion comments) now defer transient transport failures, leaving the posted flag false so the next polling interval retries. Mirrors the existing `listClickUpTaskComments` defer pattern. `createClickUpComment` stays single-attempt to avoid duplicate comments.

## 0.4.0

### Minor Changes

- c2cebbe: Agent extensions: discover, install, and inject extensions across Claude, Codex, Cursor, and Kiro.

  - Discovery scans each agent's on-disk extension locations and live-merges the results with a persisted registry.
  - Per-tool extensions surface in Settings > Agents and in the workflow step editor via the ExtensionPicker.
  - The enabled set is injected into each agent's worktree manifest at launch.
  - Install, uninstall, and discover endpoints under `/api/agent-config/extensions`.

- c2cebbe: Project paths are now repointable, and the merge-status sweep resolves from the stored PR URL instead of the local checkout.

  - `PATCH /api/projects/:id` accepts `repoPath` and cascades the change onto the project's existing tasks (`repoPath` + `targets`), keyed by `projectId`. Settings exposes a per-project Repoint action via the folder picker.
  - `getMergeRequestState` derives the PR identity from the stored merge-request URL first, with the local checkout as fallback, so a moved repo no longer reports `unknown`.
  - Merge-status failures now surface a reason (no git remote, host mismatch, missing auth, forge API error, network error) instead of a bare `unknown`.

- 3f97250: Agentic per-project quality-gate generation during onboarding.

  Onboarding now gathers project intel and emits a project-specific quality-gate config instead of relying on a single one-size-fits-all detection routine.

  - Deterministic intel gathering (`gatherProjectIntel`): scans `pyproject.toml`, `package.json`, `Makefile`, lockfiles, build/test/lint docs, and CI workflows, returning structured evidence (markers, declared scripts/targets, Python tooling, doc and CI commands). Pure and tool-agnostic; never assumes a stack.
  - Agent-driven generation (`generateProjectQualityGate`): a read-only plan turn curates the intel into a tool-agnostic config (category, command, working directory, required, evidence). Mirrors the quick-starts onboarding lifecycle.
  - No generic fallback: every check must cite concrete repo evidence. A `ready` config with no evidence-backed checks is rejected; insufficient evidence yields an explicit `incomplete` state with `needsResolution`. If the agent fails, a deterministic synthesis rebuilds the config from the gathered evidence (or `incomplete` when none exists). A generic gate is never substituted.
  - Project-aware check planner (`planProjectChecks` / `runProjectChecks`): a project's generated gate drives the gate when `ready`, taking precedence over generic `package.json`/`Makefile` detection. Explicit `.harness/checks.yml` still wins as an operator override, and harness-level tasks (no project) are unaffected.
  - API: `GET /projects/:id/quality-gate` and `POST /projects/:id/quality-gate/regenerate`.

## 0.3.0

### Minor Changes

- acdc7a9: Graceful shutdown via two independent entry points.

  - CLI: `mission-control stop` asks the running server to shut down (`POST /api/shutdown`), reading its pid/port from a runtime state file. Reports clear outcomes for stopped, not-running, and unreachable states, and cleans up stale state from a crashed server.
  - UI: a Shut down Mission Control control under System → Maintenance → Power, gated behind a confirmation modal that warns all running processes will be terminated and the UI will be unavailable until a terminal restart.
  - Shared graceful path: every entry point (Ctrl+C, UI button, `mission-control stop`) terminates all in-flight agent processes, stops the daemon, closes the HTTP server, then exits.

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
