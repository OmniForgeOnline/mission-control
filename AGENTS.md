# AGENTS.md

Machine-readable constraints for agents editing this repository. Do not restate lint, types, or directory layout.

## MUST

- Split any `src/` file approaching 500 lines before adding logic.
- In tests: `mkdtemp` + `ensureHarnessRepository(root)`; never use ambient `HARNESS_ROOT`.
- Satisfy quality gate with test **path** matching domain (`tests/<domain>.test.ts` or path contains `<domain>`). Imports alone do not count.
- File harness policy changes via `propose_rule` / `propose_skill` MCP tools.
- Write durable memory via `gbrain_propose`, not filesystem edits under `data/memory/`.
- Reuse `runAutonomyAgentTurn` for agent-based autonomy jobs (`src/autonomy/agent-run.ts`).
- Register new autonomy jobs: `src/autonomy/handlers/<name>.ts` + `src/autonomy/registry.ts`.
- Register new MCP tools: `src/mcp/tools/<name>.ts` + `src/mcp/tool-registry.ts`.

## MUST NOT

- Create PRs/MRs via `gh`, `glab`, or forge APIs. Only workflow step `create_merge_request` opens them.
- Edit `kernel/` or `skills/` in place.
- File `propose_*` when `findActiveProposalTask` would match same `kind` + `targetPath`.

## FRONTEND (UI / CSS)

Catalog master/detail is shared by Connectors, Skills, Workflows, and Settings (`catalog-shell` / `catalog-rail` / `catalog-detail` in `src/ui/styles/responsive.css`; Settings embeds use `settings-embedded-panel` in `src/ui/styles/settings.css`).

### MUST

- Write **mobile-first** CSS: default = stacked, content-sized, `overflow: visible`. Put `height: 100%`, `flex: 1 1 0`, `overflow: hidden`, and `grid-template-rows: … 1fr` only inside `@media (min-width: 1081px)` (or after mobile-first bases they intentionally override).
- Keep catalog stack breakpoint at **1080 / 1081** (`max-width: 1080px` stack, `min-width: 1081px` two-column). Do not invent a second catalog breakpoint.
- When changing layout CSS, validate **both** ≤1080 (Settings → Connectors/Skills/Workflows must show list + detail, not an empty pane) and ≥1081 (side-by-side, no dead gap between rail and detail).
- Prefer bounded scroll regions with explicit `max-height` (e.g. `.connector-map-scroll { max-height: 460px }`) over flex-fill chains that can collapse to 0 height.
- Guard layout invariants with CSS string tests in `tests/ui.test.ts` (cascade order, mobile-first bases, desktop-only fill).
- After meaningful layout CSS changes, run `node scripts/mobile-overflow-audit.mjs` against a local server at a ~390×844 viewport; fix any route that reports horizontal overflow outside an intentional scrollport (`wf-canvas-*`, `connector-map-scroll`, `overflow-x: auto|scroll`).
- Reuse existing catalog / autonomy primitives; do not nest a second bordered panel inside `catalog-panel` for a single control row.

### MUST NOT

- Declare desktop fill rules (`height: 100%`, `flex: 1 1 0`, `overflow: hidden`, `1fr` rows) **after** a `@media (max-width: 1080px)` block that tries to undo them — later equal-specificity rules win and wipe mobile.
- Use `align-content: stretch` on auto grid rows to “fill the viewport” when the detail is short — that inflates the rail and opens a gap above the detail. Give leftover height to the detail track on desktop only.
- Ship UI layout changes without checking Settings system embeds on a narrow viewport (Connectors selected → provider list and detail visible).

## INFERENCE TRAPS

- `HARNESS_ROOT` holds runtime state (tasks, settings, workflows, seeded kernel/skills). Defaults to a platform-standard dir outside any checkout (`~/Library/Application Support/mission-control` on macOS, `$XDG_DATA_HOME/mission-control` on Linux, `%APPDATA%\mission-control` on Windows).
- After confirmed push on repo-modifying author step: daemon advances `checks` → `create_merge_request` → `review` without operator action. Missing final-answer markers ≠ blocked workflow.
- CSS cascade order in `settings.css` matters as much as media queries: a base rule after `@media (max-width: 1080px)` overrides that media block.
