import {
  countStepComments,
  nodeStateLabel,
  nodeVisualState,
  stepGateKind
} from "./state.js";
import { resolvedStepAgent } from "@ui/app/state.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";

export interface WorkflowNodeProps {
  task: HarnessTask;
  workflow: WorkflowSummary;
  stepId: string;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (stepId: string) => void;
}

function stepLabel(stepId: string): string {
  return stepId.replace(/_/g, " ");
}

/**
 * Resolve a step's agent directly from a workflow's own defaults/step config.
 * Used when there is no task run (e.g. editing a draft workflow in the
 * Workflows tab), where task/global override resolution would otherwise latch
 * onto an unrelated workflow.
 */
function draftAgent(agent: string, workflow: WorkflowSummary): string | null {
  if (agent === "none") return null;
  if (agent === "author") return workflow.defaults.author;
  if (agent === "reviewer") return workflow.defaults.reviewer;
  return agent;
}

export function WorkflowNode({
  task,
  workflow,
  stepId,
  x,
  y,
  selected,
  onSelect
}: WorkflowNodeProps) {
  const step = workflow.steps[stepId];
  if (!step) return null;

  const state = nodeVisualState(stepId, task, workflow);
  const gate = stepGateKind(workflow, stepId);
  // Draft mode (no task run, e.g. the Workflows editor): derive the agent from
  // this workflow's own config. Run mode: honour task/global overrides.
  const isDraft = !task.workflowRun;
  const agent = isDraft
    ? draftAgent(step.agent, workflow)
    : resolvedStepAgent(task, stepId) ?? (step.agent === "none" ? null : step.agent);
  const comments = isDraft ? 0 : countStepComments(task, stepId);

  const classes = [
    "wf-node",
    `is-${state}`,
    selected ? "is-selected" : "",
    gate === "operator" ? "gate-operator" : "",
    gate === "daemon" ? "gate-daemon" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      class={classes}
      style={{ left: `${x}px`, top: `${y}px` }}
      aria-current={state === "current" || state === "running" ? "step" : undefined}
      aria-pressed={selected}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(stepId);
      }}
    >
      <div class="wf-node-head">
        <span class="wf-node-dot" aria-hidden="true" />
        <span class="wf-node-name">{stepLabel(stepId)}</span>
        {isDraft || state === "blocked" ? null : (
          <span class="wf-node-state">{nodeStateLabel(state)}</span>
        )}
      </div>
      <div class="wf-node-meta">
        <span class="wf-tag">{step.kind}</span>
        {agent ? <span class="wf-tag">{agent}</span> : null}
        {step.approval === "required" ? <span class="wf-tag is-approval">approval</span> : null}
      </div>
      <div class="wf-node-foot">
        {isDraft ? null : <span class={`wf-comments${comments ? " has" : ""}`}>💬 {comments}</span>}
        <span>{gate === "operator" ? "operator-gated" : gate === "daemon" ? "auto" : "standard"}</span>
      </div>
    </button>
  );
}