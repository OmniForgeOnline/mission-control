export const DEFAULT_SKILLS: Record<string, string> = {
  "harness-turn-loop/SKILL.md": `---
name: harness-turn-loop
description: Map of the per-turn loop. Loads other skills on demand instead of inlining everything.
---

# Harness Turn Loop

## When to use

First skill to consult on any task.

## How

The harness has prepared a workspace cwd, an MCP server (\`gbrain\`), optional checks, and a reviewer pass. Your loop:

1. Orient. Read the task and operator notes.
2. Search memory: \`gbrain_search(<keywords>)\`.
3. Pick a skill from the matrix and \`read_skill(<name>)\` for its body.
4. Execute and verify inside cwd.
5. Hand off with a \`operator-handoff\`-shaped final message.

| Situation | Skill |
|---|---|
| Repo-scoped change | \`pr-driven-execution\` |
| Reviewer turn | \`code-review\` |
| Durable lesson | \`proposal-first\` |
| Out-of-scope debt | \`tech-debt-capture\` |
| Mechanical checks failed | \`harness-checks\` |
| Picking up a stalled task | \`debug-prior-runs\` |
| Authoring a new skill | \`harness-skill-author\` |
| Final message | \`operator-handoff\` |

## Anti-patterns

- Inlining every skill body. Use \`read_skill\` only for what you need.
- Creating or checking PRs/MRs yourself (\`gh\`, \`glab\`, forge APIs). The harness \`create_merge_request\` workflow step opens them after push.
- Writing memory or tech-debt directly. Use MCP tools instead.
- Editing kernel/skills/hooks/data/memory directly.

## Programmatic surface

\`list_skills()\`, \`read_skill(name)\`, \`kernel_read(section?)\`, \`gbrain_search(query)\`, \`list_tasks()\`, \`list_runs()\`.
`,
  "pr-driven-execution/SKILL.md": `---
name: pr-driven-execution
description: Run checks, commit, and push. Harness create_merge_request opens PRs/MRs after push — never gh/glab.
---

# PR-Driven Execution

## When to use

Any task whose target is a git repo. The harness has set up a worktree on \`harness/<short-id>\`.

## How

1. Inspect the project setup from cwd: AGENTS/README, Makefile, lockfiles, package scripts, and \`.harness/checks.yml\` when present.
2. If dependencies are missing, run the project-appropriate setup command inside cwd. Do not borrow dependency artifacts from the destination repo outside the worktree.
3. Implement inside cwd.
4. Run project tests/lints if relevant.
5. Run relevant checks before finishing.
6. Stage only intended files, commit, and push the task branch yourself.
7. If setup, commit hooks, linting, tests, or push fail, fix them and retry before your final answer when in scope; otherwise report the exact blocker.
8. Do not create or verify PRs/MRs yourself. The harness \`create_merge_request\` workflow step opens the review request after push.
9. Final message uses \`operator-handoff\` and reports the pushed branch plus verification.

## Merge request content

The harness composes PR/MR titles and descriptions from your ticket and handoff using three sections: **Overview**, **Key Changes**, and **Impact**. Titles use conventional commit prefixes (\`feat:\`, \`fix:\`, etc.). Write handoff bullets that map to Key Changes; put verification under \`**Verified.**\` and risks under \`**Watch.**\` for Impact.

## Anti-patterns

- Running \`gh\`/\`glab\` or any forge API to create or check PRs/MRs (including \`gh pr view\` / \`gh pr list\`).
- Calling connector code to open PRs/MRs — harness workflow handles that.
- Pushing to \`main\`/\`master\`.
- Modifying anything outside cwd.

## Programmatic surface

\`list_runs(taskId)\`, \`read_run(runId, "log.txt")\`, \`tech_debt_capture(...)\`, \`gbrain_search(query)\`.
`,
  "code-review/SKILL.md": `---
name: code-review
description: Review another agent's pushed branch. Emit a structured verdict.
---

# Code Review

## When to use

Reviewer turn after the author pushed. Harness programmatically reuses the author worktree, attaches diff/changed-file excerpts, checks status, and PR/MR link.

## How

1. Start from the attached diff and excerpts; read cwd only for deeper context.
2. Comment only on changed lines with confidence ≥ 0.85 and verbatim diff evidence.
2. Decide \`approve\` | \`request_changes\` | \`comment\`.
3. Reply with fenced JSON first, then brief prose.

\`\`\`json
{
  "decision": "approve",
  "summary": "...",
  "comments": [
    {
      "file_path": "src/foo.ts",
      "start_line": 42,
      "severity": "HIGH",
      "category": "BUG",
      "confidence": 0.95,
      "title": "short title",
      "rationale": "specific impact",
      "evidence": "verbatim diff snippet",
      "fix_hint": "optional fix"
    }
  ]
}
\`\`\`

Do not flag linter/style/import issues, generic suggestions, or improvements misidentified as bugs. Only CRITICAL/HIGH/MEDIUM findings with evidence should drive \`request_changes\`.

## Anti-patterns

- Using \`gh\`, \`glab\`, or forge APIs. The harness provides the diff; reply with JSON only.
- Pushing commits yourself.
- Approving with no diff inspection.
- Findings without verbatim diff evidence.

## Programmatic surface

\`read_run(runId, "log.txt")\`, \`gbrain_search(query)\`, \`list_tasks(status="awaiting_review")\`.
`,
  "proposal-first/SKILL.md": `---
name: proposal-first
description: Promote durable harness knowledge through proposals.
---

# Proposal First

## When to use

You learned something the harness should remember.

## How

| Need | Tool |
|---|---|
| Memory | \`gbrain_propose({slug, title, content, type, tags?, rationale})\` |
| Kernel rule | \`propose_rule({targetPath, title, rationale, content})\` |
| Skill | \`propose_skill({name, description, body, rationale})\` |
| Hook | \`propose_hook({targetPath, title, rationale, content})\` |

Promote only repeatable, generalizable, stable, time-saving lessons.

## Anti-patterns

- Editing kernel/skills/hooks/data/memory directly.
- Proposing without rationale.
- Proposing the same thing across tasks instead of waiting on approval.

## Programmatic surface

\`gbrain_search(query)\`, \`list_skills()\`, \`kernel_read(section)\`.
`,
  "harness-memory/SKILL.md": `---
name: harness-memory
description: Search, read, and propose durable harness memory through gbrain.
---

# Harness Memory (gbrain)

## When to use

Whenever prior preferences/decisions/projects/entities might apply. Always before relying on training data.

## How

1. \`gbrain_search(query)\` first.
2. \`gbrain_index_search(query)\` for run logs/proposals.
3. \`gbrain_read(slug)\` to fetch a page.
4. \`gbrain_list(prefix)\` to enumerate.
5. \`gbrain_propose(...)\` to capture durable knowledge.

## Anti-patterns

- Editing \`data/memory/pages/\` directly.
- Proposing one-off observations.

## Programmatic surface

\`gbrain_search\`, \`gbrain_index_search\`, \`gbrain_read\`, \`gbrain_list\`, \`gbrain_propose\`.
`,
  "harness-checks/SKILL.md": `---
name: harness-checks
description: How mechanical checks gate your push and how to recover from failures.
---

# Harness Checks

## When to use

Repo-scoped task where the workspace has \`.harness/checks.yml\`.

## How

1. \`cat .harness/checks.yml\` early to see what will gate you.
2. Run the same commands locally before pushing.
3. If you see \`### Checks remediation round N\` in your prompt, treat it as the highest priority instruction.
4. Fix only what failed. Push on the same branch.

## Anti-patterns

- Skipping the checks.
- Suppressing failures or removing checks. File \`propose_rule\` instead.

## Programmatic surface

\`read_run(runId, "log.txt")\` for the previous turn's output.
`,
  "debug-prior-runs/SKILL.md": `---
name: debug-prior-runs
description: Inspect past runs and audit logs when picking up a stalled task.
---

# Debug Prior Runs

## When to use

\`turnCount > 0\`, \`status === "blocked"\`, or you need history.

## How

1. \`read_task(id)\` — full record + messages.
2. \`list_runs(taskId)\` — newest first.
3. \`read_run(runId, "summary.md" | "log.txt" | "prompt.md")\`.

## Anti-patterns

- Re-doing work without reading prior \`summary.md\`.
- Editing run artifacts.

## Programmatic surface

\`read_task(id)\`, \`list_runs(taskId, limit?)\`, \`read_run(runId, file)\`.
`,
  "tech-debt-capture/SKILL.md": `---
name: tech-debt-capture
description: Append a debt item so autonomy queues a synthetic task for it.
---

# Tech Debt Capture

## When to use

You noticed something worth fixing but it's out of scope this turn.

## How

\`tech_debt_capture({title, description, agent?, targets?})\`. Be specific enough that a future agent doesn't need to ask you for context.

## Anti-patterns

- Capturing things you could fix this turn.
- Vague titles ("clean up code").
- Capturing duplicates.

## Programmatic surface

\`tech_debt_capture(...)\`.
`,
  "harness-skill-author/SKILL.md": `---
name: harness-skill-author
description: Author a new skill via propose_skill with the standard structure.
---

# Harness Skill Author

## When to use

A recurring pattern across tasks deserves a skill.

## How

1. \`list_skills()\` and \`read_skill(name)\` for nearby skills first.
2. Pick a lowercase-dash name.
3. Body sections, in order: \`## When to use\`, \`## How\`, \`## Anti-patterns\`, \`## Programmatic surface\`.
4. Keep under ~80 lines.
5. \`propose_skill({name, description, body, rationale})\`. Frontmatter is added by the harness.

## Anti-patterns

- Free-form structure.
- Inlining tool schemas.
- Editing \`skills/\` directly.

## Programmatic surface

\`list_skills()\`, \`read_skill(name)\`, \`propose_skill(...)\`.
`,
  "operator-handoff/SKILL.md": `---
name: operator-handoff
description: Final-message template. Reviewer and operator both read this.
---

# Operator Handoff

## When to use

Every author turn ends with this template.

## How

\`\`\`
**Pushed.** <branch> · <N> commit(s) · <summary>
**Verified.** <commands run, results>
**Open.** <not done this turn>
**Watch.** <residual risk, debt>
**Next.** <single concrete next step>
\`\`\`

For non-repo tasks, replace \`**Pushed**\` with \`**Changed.** <files touched>\`.

## Anti-patterns

- "Done." without naming what.
- Mixing reviewer JSON with the handoff. Author = handoff only.
- Promising follow-ups in prose. Use \`tech_debt_capture\`.

## Programmatic surface

\`tech_debt_capture(...)\`.
`
};
