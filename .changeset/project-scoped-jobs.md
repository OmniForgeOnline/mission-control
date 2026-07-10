---
"@omniforge/mission-control": minor
---

Project-scoped jobs schema and migrate the harness guidance sweep out of global scope.

- New machine-checkable schema for project-scoped jobs (`ProjectJobDefinition` + `PROJECT_JOB_JSON_SCHEMA` + `validateProjectJobDefinition`) so any user or agent can author and validate custom jobs scoped to their own project. The harness guidance sweep is the reference instance the schema is derived from.
- Two MCP tools: `validate_project_job` (pure schema check) and `define_project_job` (validate then register for a project). Custom jobs without a built-in handler run as agent turns driven by their `instructions`.
- The harness guidance sweep moves from a global default job to a project-scoped job owned by the harness project (the mission-control repo). It seeds only when an onboarded project's `package.json` name is `@omniforge/mission-control`, so a public install no longer spends every user's tokens improving a single repo. Roll-forward only: no backward-compatible global alias; stored globals are auto-pruned on next load.
