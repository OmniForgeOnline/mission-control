import type { WorkflowStep, WorkflowStepKind } from "./types.ts";
import { stepIsReadOnlyInvestigation } from "./graph.ts";

function defaultObjective(kind: WorkflowStepKind, modifiesRepo?: boolean): string {
  switch (kind) {
    case "conversation":
      return "Produce a clear plan through multi-turn conversation with the operator.";
    case "agent_turn":
      if (modifiesRepo === false) {
        return "Investigate the codebase, gather evidence, and produce an actionable technical plan.";
      }
      return modifiesRepo
        ? "Implement the approved work in the prepared workspace."
        : "Complete the assigned agent work for this step.";
    case "review":
      return "Review the author's changes and emit a structured verdict.";
    case "create_merge_request":
      return "Open or update the merge request for the harness branch.";
    case "resolve_conflicts":
      return "Resolve merge conflicts blocking the merge request.";
    case "terminal":
      return "Finalize operator handoff for this workflow.";
    default:
      return "Complete this workflow step.";
  }
}

function defaultRequiredArtifact(kind: WorkflowStepKind, modifiesRepo?: boolean): string | undefined {
  switch (kind) {
    case "conversation":
      return "Final plan in a <proposed_plan> block or prefixed with FINAL_PLAN:";
    case "agent_turn":
      if (modifiesRepo === false) {
        return "Investigation report in a <proposed_plan> block with reproduction, evidence, root cause or hypothesis, affected surface, test strategy, and confidence.";
      }
      return modifiesRepo ? "Committed and pushed changes on the harness branch." : undefined;
    case "review":
      return "Structured review verdict JSON.";
    default:
      return undefined;
  }
}

function defaultAllowedActions(kind: WorkflowStepKind, modifiesRepo?: boolean): string[] {
  switch (kind) {
    case "conversation":
      return ["plan", "converse"];
    case "agent_turn":
      if (modifiesRepo === false) {
        return ["read", "diagnose", "analyze", "report"];
      }
      return modifiesRepo
        ? ["read", "edit", "test", "commit", "push"]
        : ["read", "analyze", "report"];
    case "review":
      return ["read", "review"];
    case "create_merge_request":
    case "resolve_conflicts":
      return ["harness-automation"];
    case "terminal":
      return ["handoff"];
    default:
      return ["read"];
  }
}

function defaultExitCriteria(kind: WorkflowStepKind, modifiesRepo?: boolean): string | undefined {
  switch (kind) {
    case "conversation":
      return "Operator receives a final plan marker or answers your blocking question.";
    case "agent_turn":
      if (modifiesRepo === false) {
        return "Evidence-backed investigation artifact is emitted without mutating the repository.";
      }
      return modifiesRepo
        ? "Relevant checks pass, changes are committed and pushed, and the final message summarizes what shipped."
        : "The step objective is met and the final message reports completion or a blocker.";
    case "review":
      return "Verdict JSON is emitted with approve or changes_requested.";
    default:
      return undefined;
  }
}

function defaultRiskClass(kind: WorkflowStepKind, modifiesRepo?: boolean): string {
  if (modifiesRepo === false && kind === "agent_turn") return "read-only-investigation";
  if (modifiesRepo) return "repo-mutation";
  switch (kind) {
    case "conversation":
      return "planning";
    case "review":
      return "review";
    case "create_merge_request":
    case "resolve_conflicts":
      return "forge-integration";
    default:
      return "operational";
  }
}

function formatList(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

/**
 * Stable workflow-step contract appended after the kernel summary and skills index.
 * The configured skill is loaded separately into the stable prompt prefix.
 */
export function buildStepContractSection(workflowId: string, step: WorkflowStep): string {
  const objective = step.objective ?? defaultObjective(step.kind, step.modifiesRepo);
  const requiredArtifact =
    step.requiredArtifact ?? defaultRequiredArtifact(step.kind, step.modifiesRepo);
  const allowedActions = step.allowedActions ?? defaultAllowedActions(step.kind, step.modifiesRepo);
  const exitCriteria = step.exitCriteria ?? defaultExitCriteria(step.kind, step.modifiesRepo);
  const riskClass = step.riskClass ?? defaultRiskClass(step.kind, step.modifiesRepo);

  const lines = [
    "## Workflow step contract",
    "",
    `- Workflow: \`${workflowId}\``,
    `- Step: \`${step.id}\` (${step.kind})`,
    `- Objective: ${objective}`,
    ...(requiredArtifact ? [`- Required artifact: ${requiredArtifact}`] : []),
    `- Allowed actions: ${formatList(allowedActions)}`,
    ...(step.entryContext ? [`- Entry context: ${step.entryContext}`] : []),
    ...(exitCriteria ? [`- Exit criteria: ${exitCriteria}`] : []),
    `- Risk class: ${riskClass}`,
    ...(step.downstreamConsumer ? [`- Downstream consumer: ${step.downstreamConsumer}`] : []),
    `- Approval gate: ${step.approval}`,
    ...(stepIsReadOnlyInvestigation(step)
      ? ["- Repo mutation: no (read-only investigation)"]
      : step.modifiesRepo
        ? ["- Repo mutation: yes (isolated harness worktree)"]
        : [])
  ];

  if (step.skill) {
    lines.push(
      "",
      `Required skill \`${step.skill}\` is loaded below; follow its instructions for this step.`
    );
  }

  return lines.join("\n");
}
