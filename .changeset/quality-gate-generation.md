---
"@omniforge/mission-control": minor
---

Agentic per-project quality-gate generation during onboarding.

Onboarding now gathers project intel and emits a project-specific quality-gate config instead of relying on a single one-size-fits-all detection routine.

- Deterministic intel gathering (`gatherProjectIntel`): scans `pyproject.toml`, `package.json`, `Makefile`, lockfiles, build/test/lint docs, and CI workflows, returning structured evidence (markers, declared scripts/targets, Python tooling, doc and CI commands). Pure and tool-agnostic; never assumes a stack.
- Agent-driven generation (`generateProjectQualityGate`): a read-only plan turn curates the intel into a tool-agnostic config (category, command, working directory, required, evidence). Mirrors the quick-starts onboarding lifecycle.
- No generic fallback: every check must cite concrete repo evidence. A `ready` config with no evidence-backed checks is rejected; insufficient evidence yields an explicit `incomplete` state with `needsResolution`. If the agent fails, a deterministic synthesis rebuilds the config from the gathered evidence (or `incomplete` when none exists). A generic gate is never substituted.
- Project-aware check planner (`planProjectChecks` / `runProjectChecks`): a project's generated gate drives the gate when `ready`, taking precedence over generic `package.json`/`Makefile` detection. Explicit `.harness/checks.yml` still wins as an operator override, and harness-level tasks (no project) are unaffected.
- API: `GET /projects/:id/quality-gate` and `POST /projects/:id/quality-gate/regenerate`.
