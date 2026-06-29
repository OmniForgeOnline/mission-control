# Plan: per-agent plugin/skill management in mission-control

Status: plan only (no implementation). Task `ccc33c409329`.
Date: 2026-06-29.

## TL;DR recommendation

The three candidate approaches are **not alternatives at the same layer**, so "pick one" is the wrong frame. They are three layers of one feature:

- Approach 1 (manage plugins/skills directly from MC) is the **management surface**.
- Approach 2 (hook tool-specific plugins to specific workflow steps) is a **policy** (which extension binds to which step).
- Approach 3 (central management in MC, declare per-agent/per-step enablement at spin-up) is the **enforcement mechanism**.

Approach 1 alone cannot solve the stated problem, because editing a user's global tool config (for example `~/.claude/settings.json`) to disable a plugin turns it off everywhere and mutates shared state. That kills the "valuable when needed" benefit and gives no per-step scoping. Approach 2 alone has nothing to enforce with. Approach 3 is the only one that actually scopes context at launch time, and it composes cleanly with 1 (a central registry) and 2 (a per-step binding).

**Recommendation: build approach 3 as the spine, surfaced by approach 1 in the reworked Settings > Agents page, with approach 2 expressed as a per-step binding matrix on top of the same registry.** This is cheap because mission-control already has the two mechanisms it needs: per-launch, per-tool config injection (`src/mcp/launcher.ts: writeMcpConfig`) and per-step routing (`src/core/agents/stage-agents.ts: resolveStepRouting`). The plan extends both rather than building a new subsystem.

This also delivers the operator's reframing literally: mission-control becomes a **plugin broker** for the agent tools (discover, install, disable, uninstall, and scope), from one UI, without forcing the operator to drop into each tool's own config.

---

## 1. Problem (one sentence, then evidence)

Every registered agent tool loads its full set of skills, subagents, MCP servers, and plugins from the user's global config on every launch, regardless of workflow step or task. Skills are model-invoked and auto-discovered, so even unused skills cost context: their descriptions are injected into the system prompt at session start. Mission-control today injects only its own gbrain MCP server; it has no model of the agent tools' own extensions, so it cannot install, disable, or scope them.

First-hand evidence of the bloat: the `claude-seo` plugin registers roughly two dozen subagents (`seo-backlinks`, `seo-cluster`, `seo-content`, `seo-technical`, `seo-geo`, and so on) plus an `seo` skill. They are all present and loaded in this very session's available agent/skill list, even though this task has nothing to do with SEO. That is the exact cost we want to eliminate for non-SEO turns.

---

## 2. Verified research: how each tool actually models extensions

Sources are cited in section 8. This corrects the prior turn, which claimed (falsely) that only Claude Code has plugins/skills. All four tools the operator named have a "skills" concept; three of four also have plugins/marketplaces. The `SKILL.md` Agent-Skills format is now a cross-vendor standard.

### Cross-vendor convergence (important for the design)

Every target tool exposes the same five extension primitives, under slightly different names:

| Primitive | Claude Code | Codex | Kiro | Cursor / cursor-cli |
|---|---|---|---|---|
| Skills (model-invoked) | Skills (`SKILL.md`) | Skills (`skills.config`, `SKILL.md`) | Agent Skills + Steering | Skills |
| Subagents | Subagents (`agents/`) | Subagents (`agents.*`) | (agent hooks / steering) | Subagents |
| Hooks | Hooks (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, ...) | Hooks (same event set) | Hooks (`PostFileSave`, `PreToolUse`, ...) | Hooks |
| MCP | MCP (`.mcp.json`) | MCP (`mcp_servers.*`) | MCP | MCP (`.cursor/mcp.json`) |
| Plugins / marketplace | Plugins + marketplaces (`enabledPlugins`, `extraKnownMarketplaces`) | Plugins + marketplaces (`plugins.*`, `features.plugins`) | Powers (distribution model) | Plugins + (marketplace) |

The hook event schemas are near-identical across Claude Code, Codex, and Kiro (`SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`), which matters if approach 2 ever needs to gate via hooks.

### Per-tool config levers (this is what mission-control would write/override)

**Claude Code** (`docs.claude.com/en/docs/claude-code/{plugins,skills,settings}`):
- Config files: `~/.claude/settings.json` (user), `.claude/settings.json` (project, shared), `.claude/settings.local.json` (project, local, git-ignored), `.mcp.json`, plus enterprise managed files.
- Plugin on/off: the `enabledPlugins` map, format `"plugin@marketplace": true|false`, valid at user/project/local scopes. Declared marketplaces via `extraKnownMarketplaces`.
- Skill on/off: there is **no per-skill enable flag**. Skills are auto-discovered from `~/.claude/skills/`, `.claude/skills/`, and plugin-bundled `skills/`. To disable a skill you disable its bundling plugin (via `enabledPlugins`) or omit its folder. So for Claude Code the unit of scoping is the **plugin**.
- Per-launch override: precedence is managed > **command-line args** > local project > shared project > user. MC already passes `--mcp-config <file>`. A worktree-local `.claude/settings.local.json` with `enabledPlugins` overrides the user's global settings for that launch.

**Codex** (`developers.openai.com/codex/config-reference`):
- Config files: `~/.codex/config.toml` (user), `.codex/config.toml` (project, loaded only when the project is trusted), `$CODEX_HOME/<profile>.config.toml` (selected with `--profile`), `requirements.toml` (admin-enforced).
- Plugin on/off: `plugins.<plugin>.mcp_servers.<server>.enabled` and `features.plugins`; marketplace allowlists via `[marketplaces]` in `requirements.toml`.
- Skill on/off: **per-skill flag exists**: `skills.config = [{ path = "...", enabled = bool }]`, plus `features.skill_mcp_dependency_install` and `approval_policy.granular.skill_approval`. So Codex can scope at the individual skill.
- Per-launch override: codex accepts `-c key=value` TOML overrides on the command line. MC already uses `-c` to register the gbrain MCP server, so toggling `plugins.*` and `skills.config` per launch is a one-line extension.

**Kiro** (`kiro.dev/docs`):
- Concepts: Specs, **Powers**, **Hooks**, **Steering**, **Agent Skills**, MCP. Hooks live in `.kiro/hooks/` (workspace) or `~/.kiro/hooks/` (user), JSON, each with an `enabled` flag. Steering/Agent Skills are file-based under `.kiro/`.
- Kiro's distribution model is "Powers" rather than a Claude/Codex-style plugin marketplace; the docs do not document a headless per-launch skill on/off lever the way Codex/Claude do.
- Implication: Kiro support is real (Skills + Hooks + Steering exist and are file-driven), but its programmatic/headless scoping is less documented, so it lands in a later phase.

**Cursor / cursor-cli** (`docs.cursor.com`):
- Customize section lists **Plugins, Rules, Skills, Subagents, Hooks, MCP**. Rules are `.cursor/rules/*.mdc`; MCP is `.cursor/mcp.json`.
- `cursor-cli` exposes "ACP Headless / CI". Cursor's plugin/skill model is the newest of the four; treat it as adapter/ACP-driven and phase it after Claude/Codex.

### Mission-control's adapters today

`RunnerAdapter` (`src/core/agents/config/types.ts`) is `"codex" | "claude" | "grok" | "opencode" | "acp" | "generic"`. Bespoke launch behavior exists for codex/claude/grok/opencode; everything else uses `generic` + a `commandTemplate`. Kiro and cursor-cli would run through `generic`/`acp` unless bespoke adapters are added.

---

## 3. Mission-control today (grounded in code)

The plan reuses these existing pieces. File paths are real.

- **Agent config** lives in `data/state/agent-config.json`, typed by `AgentConfigBundle` (`src/core/agents/config/types.ts`): `tools[]` (`AgentToolConfig`: id, command binary, adapter, enabled, builtin, cli flags, `commandTemplate`, `externalMcpInjection`, usage), `pools[]` (`ModelPoolConfig`: modelArgs, modelEnv, capabilities, tier), and `profiles[]` (`RoutingProfileConfig`: role to requiredCapability + minQuality). Managed via `PUT/DELETE /api/agent-config/*`. This is the natural home for an "extensions" registry.
- **Per-step routing already exists.** `src/core/agents/stage-agents.ts: resolveStepRouting(root, workflowId, stepId, taskOverrides)` resolves a workflow step to a concrete `{toolId, modelPoolId}` using the workflow definition, per-step overrides in `data/state/stage-agents.json`, the harness default agent, and the optimizer. This is exactly the seam where per-step extension scoping belongs.
- **Per-launch config injection already exists.** `src/mcp/launcher.ts: writeMcpConfig` writes a tool-specific config into the **run dir** and passes it per launch, adapter by adapter:
  - Claude: writes `mcp-config.json` into `runDir`, passes `--mcp-config <path>`.
  - Codex: passes `-c mcp_servers.gbrain.command=...` (and args) as per-launch TOML overrides.
  - opencode: writes `opencode-mcp.json` + `OPENCODE_CONFIG_CONTENT` env.
  - grok: imperative `mcp add`.
  - This is the exact pattern to extend for plugin/skill enablement.
- **Isolation already exists.** Each agent turn runs in its own git worktree (`cwd`). That means mission-control can drop a tool-specific config file (a worktree-local `.claude/settings.local.json`, a codex `-c` override, a `.kiro/` file) that scopes extensions for that one launch **without ever touching the user's global config**. This is the property that makes approach 3 strictly better than approach 1.
- **MC does not touch the tools' own settings today.** Grep confirms MC writes only `data/state/settings.json`, `data/state/agent-config.json`, `data/state/stage-agents.json`, and the run-dir MCP config. It never writes `~/.claude/settings.json`, `~/.codex/config.toml`, etc.
- **The settings page to rework** is `src/ui/features/settings/agents/config-section.tsx` (titled "Tools & model pools"): one card per tool with enable/disable, model pools with usage bars, and a pointer to the `add-agent-cli` skill. It currently has no notion of the tools' plugins/skills.

---

## 4. The three approaches, evaluated honestly

**Approach 1: manage plugins/skills directly from MC (MC as control panel).**
- Pros: best UX, matches the operator's "nicer than opening each tool" ask; single source of truth; enables the "found a cool plugin online, install from MC" flow.
- Cons: if it only edits global tool config (`~/.claude/settings.json`), disabling claude-seo turns it off everywhere (loses "valuable when needed") and mutates shared state the user also edits by hand (drift, footgun). And it gives no per-step scoping, so it does not by itself solve context bloat.
- Verdict: necessary as a UI/registry, insufficient as the mechanism.

**Approach 2: hook tool-specific plugins to specific workflow steps, activate only there.**
- Pros: this is the policy that actually expresses "claude-seo only on SEO steps." Reuses the per-step routing pipeline that already exists.
- Cons: a policy with no enforcement mechanism does nothing. It needs approach 3 to actually turn extensions on/off at launch.
- Verdict: correct policy layer, but cannot stand alone.

**Approach 3: central management in MC, declare per-agent/per-step enablement at spin-up.**
- Pros: this is the enforcement. It scopes extensions per launch, in the isolated worktree, with zero global mutation, reusing `writeMcpConfig` and `resolveStepRouting`. It is what makes approaches 1 and 2 real.
- Cons: needs an "extensions" registry (small schema addition) and a per-step extensions facet on workflow definitions; per-tool mechanism differs (see mapping below); must be verified empirically that disabling actually drops skill descriptions from context.
- Verdict: the spine. Build this; layer 1 (UI) and 2 (policy) on top.

**Why not pure 1 or pure 2:** pure 1 fails the context-bloat goal (global off, or global footgun). Pure 2 has no teeth. Only 3 enforces, and only 3 composes with the others.

---

## 5. Recommendation and scope

Build a unified **extension registry** in mission-control and scope it at launch. Concrete shape:

1. **Registry** (data): add an extensions concept to `agent-config.json` (or a sibling `extensions.json`). Each entry: `{ toolId, kind: "plugin"|"skill"|"subagent"|"mcp", source/manifest ref, enabled, detected-from }`. Discovery reads each tool's real config on disk (Claude's installed plugins/skills dirs, Codex's `config.toml` `plugins`/`skills.config`, etc.). This is approach 1's data backbone.

2. **UI** (approach 1): rework `config-section.tsx` so each tool card lists its discovered extensions with install/disable/uninstall and an enable matrix. This is the operator's "manage from MC" surface.

3. **Launch injection** (approach 3 mechanism): generalize `writeMcpConfig` into `writeLaunchExtensions({ tool, runDir, cwd, extensions, step })` that, in addition to the gbrain MCP server, emits the scoped extension set per adapter, into the worktree/run dir (never global):
   - Claude: write a worktree `.claude/settings.local.json` carrying `enabledPlugins` for this launch (plus the existing `--mcp-config`). Unit of scoping = plugin.
   - Codex: add `-c plugins.<p>.mcp_servers.<s>.enabled=...` and `-c skills.config=[{path,enabled}]` to the existing `-c` chain. Unit of scoping = plugin or individual skill.
   - opencode / grok / generic: extend their existing injection paths.
   - Kiro / cursor-cli: file-based (`.kiro/`, `.cursor/`) where the CLI reads project config; adapter/ACP-driven; phase later.
   Wire the result into `resolveAgentLaunchPlan` so the launch `args`/`env`/config reflect the scoped set.

4. **Per-step binding** (approach 2 policy): add an optional `extensions` facet to workflow step definitions and thread it through `resolveStepRouting`/`resolveAgentForStep`. A step can request specific extensions (for example, an "seo" catalog step requests the claude-seo plugin); the launch injector then turns exactly those on for that step's agent. The per-step overrides already stored in `stage-agents.json` are the precedent for per-step config.

Scope decision (KISS): ship Claude Code and Codex support first (they have the cleanest, documented per-launch levers and are MC's bespoke adapters). Kiro and Cursor come after, via generic/acp adapters, once their headless scoping is verified. Start with plugins + skills (the context-bloat drivers); subagents and MCP follow.

---

## 6. Phased rollout

- **Phase 0 (de-risk, no UI):** empirical spikes. (a) Confirm a worktree-local `.claude/settings.local.json` with `"claude-seo@...": false` actually removes the seo subagents/skill from a Claude Code session's context. (b) Confirm codex `-c` can toggle `plugins.*.enabled` and `skills.config` per launch and that disabled skills drop from context. (c) Confirm the run-dir/worktree boundary each adapter sees as CWD. These three checks gate everything; if any fails, the mechanism changes.
- **Phase 1 (registry + UI):** discovery + the reworked Settings > Agents page (approach 1). Install/disable/uninstall per tool. End-to-end tests around discovery and the `/api/agent-config/*` extension endpoints.
- **Phase 2 (per-launch scoping):** `writeLaunchExtensions` per adapter, wired into the launch plan (approach 3 mechanism). Tests asserting the emitted config enables exactly the requested set and writes only into the worktree/run dir.
- **Phase 3 (per-step binding):** extensions facet on workflow steps + routing wiring (approach 2 policy). Tests via `resolveStepRouting`.
- **Phase 4 (breadth):** Kiro and cursor-cli adapters; subagent and MCP scoping; optional install-from-marketplace from MC (behind a security gate).

---

## 7. Risks and open questions

Risks:
- **Global mutation footgun.** Any path that edits `~/.claude/settings.json` or `~/.codex/config.toml` directly must be rejected by design. The worktree-scoped per-launch config is the mitigation; the registry's "disable" must mean "off for this launch/scope," not "rewrite global config." The one exception is a deliberate, operator-confirmed global install/uninstall.
- **"Disabled" must be verified to actually free context.** Skills are model-invoked and auto-discovered; disabling a plugin must be confirmed to drop its bundled skill descriptions, not just hide a UI toggle. Phase 0 exists for this.
- **Trust boundary.** Codex skips project `.codex/` layers for untrusted projects, and Claude/Codex both gate marketplace sources. MC must set trust/allowlists when relying on worktree-scoped config (or prefer explicit per-launch flags like codex `-c`).
- **Untrusted plugin code.** Approach 1's "install a cool plugin from MC" is a prompt-injection / untrusted-supply-chain surface. Gate installs behind explicit operator confirmation and prefer allowlisted marketplaces (Codex `[marketplaces]`, Claude `extraKnownMarketplaces`).
- **Per-tool drift.** Each tool changes its config schema often (Codex's `config-reference` is large and evolving). The adapter layer must isolate this; discovery must degrade gracefully when a tool's schema changes.
- **Schema/test cost.** Adding an extensions facet to workflow definitions and registry types touches `normalize.ts`, `validate.ts`, and the UI; keep the type additive and optional to avoid breaking existing `agent-config.json` files.

Open questions for the operator:
1. Scope of "extensions" to manage first: plugins only (smallest, covers the claude-seo case), or plugins + skills? Recommendation: plugins + skills (the bloat drivers); subagents/MCP later.
2. Per-step binding granularity: per-workflow-step (an "seo" catalog step), or also per-task-tag/label? Recommendation: per-step first.
3. Install ambition: Phase 1 just manage/disable already-installed extensions, or also install-from-marketplace inside MC? Recommendation: manage-first; install-from-marketplace later, behind the security gate.
4. Should MC's own built-in skills (`skills/`, surfaced via gbrain `read_skill`) also get per-step scoping for consistency? They are loaded on demand via `read_skill`, so they are a smaller bloat problem today, but the model still sees their full list up front.
5. Should global "disable everywhere" (the approach-1 footgun) be offered at all, or only worktree-scoped per-launch scoping? Recommendation: worktree-scoped only by default; global disable requires explicit confirmation.

---

## 8. Sources (all fetched 2026-06-29)

- Claude Code plugins: https://docs.claude.com/en/docs/claude-code/plugins
- Claude Code settings (enabledPlugins, precedence, MCP): https://docs.claude.com/en/docs/claude-code/settings
- Claude Code Agent Skills: https://docs.claude.com/en/docs/claude-code/skills
- Codex configuration reference (plugins, skills.config, hooks, marketplaces, -c): https://developers.openai.com/codex/config-reference
- Codex config index: https://raw.githubusercontent.com/openai/codex/main/docs/config.md
- Kiro hooks: https://kiro.dev/docs/hooks
- Kiro docs index (Powers, Steering, Agent Skills, MCP): https://kiro.dev/docs
- Cursor docs (Customize: Plugins, Rules, Skills, Subagents, Hooks, MCP; cursor-cli ACP): https://docs.cursor.com/agent/rules and https://docs.cursor.com

Codebase references (this repo): `src/core/agents/config/types.ts`, `src/core/agents/stage-agents.ts`, `src/mcp/launcher.ts`, `src/ui/features/settings/agents/config-section.tsx`, `skills/add-agent-cli/SKILL.md`.
