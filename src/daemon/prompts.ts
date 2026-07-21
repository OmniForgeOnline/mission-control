import { withAttachmentReferences } from "../core/attachments/paths.ts";
import { formatOperatorNotes } from "../core/prompts/operator-notes.ts";
import { buildStepContractSection } from "../core/workflows/step-contract.ts";
import { stepIsReadOnlyInvestigation } from "../core/workflows/graph.ts";
import type { WorkflowStep } from "../core/workflows/types.ts";
import type { HarnessTask } from "../core/types.ts";
import type { PreparedWorkspace } from "../core/worktrees/worktrees.ts";

const KERNEL_SUMMARY = `## Mission Control contract (compressed)

- Repo is system of record. Kernel rules live under \`kernel/\`; load full text with \`kernel_read(section)\`.
- Approved tasks may execute autonomously inside scope. Stop for: durable Mission Control changes, destructive ops, credential changes, external publication, unclear scope expansion.
- Never edit \`kernel/\`, \`skills/\`, or \`hooks/\` directly. Use \`propose_rule\`, \`propose_skill\`, or \`propose_hook\` for repo-backed Mission Control changes.
- Personal memory lives locally in gitignored \`data/memory/pages/\`. Mission Control auto-captures operator corrections, lessons, project context, and completion summaries; use \`gbrain_propose\` to add durable pages directly (no task/worktree). Use \`gbrain_search\` / \`gbrain_read\` for deeper lookup when needed.
- Repo-scoped tasks: branch, commit, push. Never run \`gh\`/\`glab\` or forge APIs to create/check PRs. The Mission Control \`create_merge_request\` workflow step opens PRs/MRs after push.
- Mechanical checks (\`.harness/checks.yml\`) and repository hooks are part of your author loop; fix failures before you push.
- A reviewer agent runs after every push. Author writes \`operator-handoff\`-shaped final messages; reviewers reply with the JSON verdict block from \`code-review\`.
- Skill catalogue bodies are not inlined by default. The workflow-bound skill is loaded below; use \`read_skill(name)\` for any others.
`;

export function buildStableAgentPrefix(
  root: string,
  task: HarnessTask,
  skills: string,
  workflowId: string,
  step: WorkflowStep,
  requiredSkillSection = ""
): string {
  return `${KERNEL_SUMMARY}

## Mission Control Skills (load with read_skill)

${skills}

${buildStepContractSection(workflowId, step)}
${requiredSkillSection ? `\n${requiredSkillSection}\n` : ""}
Mission Control root: ${root}
Task id: ${task.id}
Task title: ${task.title}
Source: ${task.source}
`;
}

export function buildInitialPrompt(
  root: string,
  task: HarnessTask,
  skills: string,
  workspace: PreparedWorkspace,
  workflowId: string,
  step: WorkflowStep,
  memorySection = "",
  checksSection = "",
  requiredSkillSection = ""
): string {
  const readOnlyInvestigation = stepIsReadOnlyInvestigation(step);
  const repoSection = readOnlyInvestigation
    ? `## Workspace (read-only investigation)

Inspect the repository and run non-mutating diagnostics from this cwd. Cite file paths, commands, and outputs as evidence.

- Workspace cwd: ${workspace.cwd}
${workspace.repoPath ? `- Project repo: ${workspace.repoPath}` : ""}

Rules for this step:
1. Do NOT edit files, create patches, commit, push, or run commands that mutate package state or external systems.
2. Prefer finishing in one turn when the task is simple; ask the operator only when truly blocked.
3. Emit your investigation artifact in a \`<proposed_plan>\` block (or prefix with \`FINAL_PLAN:\`) so downstream steps receive the plan without replaying this transcript.
4. Structure your investigation artifact with these exact sections, each present and non-empty: ## Reproduction, ## Root Cause, ## Evidence, ## Affected Surface, ## Test Strategy, ## Confidence. An unsupported hypothesis (empty ## Evidence) will be rejected and you will be asked to retry.
`
    : workspace.isRepo
    ? `## Workspace (git worktree)

You are running in an isolated git worktree. Mission Control has already prepared it for you.

- Workspace cwd: ${workspace.cwd}
- Destination repo: ${workspace.repoPath}
- Branch: ${workspace.branch}

Workflow contract for repo-scoped tasks:

1. Stay inside ${workspace.cwd}. Do not modify the destination repo elsewhere.
2. Before implementing, inspect the project's own setup signals from this worktree (for example AGENTS, README, Makefile, lockfiles, package scripts, and .harness/checks.yml). If dependencies are missing, run the project-appropriate setup command inside ${workspace.cwd}; do not borrow dependency artifacts from the destination repo.
3. Make your code changes here. Run any relevant tests before finishing the turn.
4. You must run the relevant checks, stage intended files, commit, and push branch \`${workspace.branch}\` before claiming completion.
5. If setup, commit hooks, linting, tests, or push fail, fix them inside this turn when in scope; otherwise report the exact blocker. Do not leave uncommitted work for Mission Control to commit.
6. The Mission Control \`create_merge_request\` workflow step opens PRs/MRs after a valid push. Do not run gh/glab or forge APIs yourself.
7. Your final message must summarize what you pushed and call out anything an operator must do manually.
`
    : `## Workspace (non-repo)

The destination is not a git repository. There is no branch and no push step.

- Workspace cwd: ${workspace.cwd}

Edit files in place. Do not initialize git here unless the task explicitly asks for it.
`;

  return `You are running under OmniForge Mission Control.

${buildStableAgentPrefix(root, task, skills, workflowId, step, requiredSkillSection)}
${memorySection ? `\n${memorySection}\n` : ""}
${repoSection}
${checksSection ? `\n${checksSection}\n` : ""}
## Task description

${withAttachmentReferences(task.description, root, task.attachments)}

## Links

${task.links.map((link) => `- ${link.label}: ${link.url}`).join("\n") || "- none"}

## Targets

${task.targets.map((target) => `- ${target.kind}: ${target.path}`).join("\n") || "- none"}

## Operator notes (older first)

${formatOperatorNotes(task.messages)}

When you are done with this turn, write a clear final message that either reports what you pushed, asks the operator a focused question, or describes a blocker. The operator will read your message in Mission Control and reply asynchronously.
`;
}
