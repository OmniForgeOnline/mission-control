export const DEFAULT_KERNEL_FILES: Record<string, string> = {
  "operating-principles.md": `# Operating Principles

The harness repository is the system of record. Generated bootstraps and indexes can always be rebuilt from it.

## Core rules

- One source of truth: kernel + skills + memory in this repo. Don't duplicate policy elsewhere.
- Approved tasks may execute autonomously inside scope. Stop for: durable harness changes, destructive operations, credential changes, external publication, or unclear scope expansion.
- Never apply rule, skill, or hook changes silently. Use proposal tickets (\`propose_rule\`, \`propose_skill\`, \`propose_hook\`). Personal memory writes locally via \`gbrain_propose\` (gitignored, no task/worktree).
- Every change should be small enough to reason about; prefer iteration over a single big push.
- Don't store secrets in this harness. Use existing CLIs, keychains, or env var names.
`,
  "autonomy-policy.md": `# Autonomy Policy

Tasks move queued → approved before any agent runs. Approved tasks may execute end-to-end inside scope.

## Autonomy jobs

Background jobs may:
- Refresh generated state (memory index, quality grades).
- Draft proposals (\`propose_rule\`, \`propose_skill\`, \`propose_hook\`, \`gbrain_propose\`).
- Append items to the tech-debt ledger (\`tech_debt_capture\`) for \`tech-debt-sweep\` to queue as synthetic tasks.
- Queue synthetic tasks for domains below grade A via \`quality-gate-sweep\`.

Background jobs must not:
- Apply durable harness changes silently.
- Publish externally.
- Modify credentials.
- Execute destructive operations on resources outside the harness.

Synthetic tasks created by autonomy go through the same approval-and-review flow as operator-issued tasks.
`,
  "workflow-policy.md": `# Workflow Policy

Every approved task runs as one or more headless turns under this contract.

## Per-turn loop

1. Read the prompt: kernel, skills index, task, targets, operator notes, workspace.
2. Search memory if prior context might apply (\`gbrain_search\`).
3. Plan briefly if the change is non-trivial.
4. Execute inside the workspace cwd. Don't touch files outside it.
5. For repo-scoped tasks: run relevant checks, stage intended files, commit, and push the harness branch yourself before claiming completion. Fix commit hooks, lint, tests, and push failures in-band.
6. The harness \`create_merge_request\` workflow step opens the PR/MR after a valid push; never run \`gh\`/\`glab\` or forge APIs to create or check them.
7. Final message: report what you pushed, what you verified, what's open. The reviewer agent and the operator both read it.

## Escalation

Stop and ask the operator when:
- The task scope is unclear or appears to expand.
- Credentials, secrets, or external publication are required.
- A durable harness change is needed — use \`propose_rule\` / \`propose_skill\` for kernel and skills; edit \`.harness/hooks.yml\` directly for runtime hooks; use \`gbrain_propose\` for personal memory (not a task ticket).
- A destructive operation outside the workspace is required.
`,
  "memory-policy.md": `# Memory Policy

The harness has one durable memory store: \`data/memory/pages/\`. Generated indexes live under \`data/state/memory-index/\`. The agent-callable surface is the \`gbrain\` MCP server.

## Rules

- Search memory before relying on training data when prior preferences, decisions, projects, or entities might apply.
- \`data/memory/pages/\` is personal and gitignored — it never goes through task tickets, worktrees, or PRs.
- The harness auto-captures durable wiki pages from operator corrections, explicit agent lessons, project/task context, and completed outcomes. Agents may also write memory directly with \`gbrain_propose\` when they articulate something new during a turn.
- Promote a memory only when it is repeatable, generalizable, stable, and time-saving. Raw observations stay in run artifacts.

## Lookup chain

1. \`gbrain_search(query)\` — most precise, fastest.
2. \`gbrain_index_search(query)\` — wider net (artifacts + proposals).
3. External sources only when the harness has nothing relevant.
`
};
