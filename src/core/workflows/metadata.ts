import type { StageAgentOverrides } from "../agents/stage-agents.ts";
import { loadAllWorkflows } from "./cache.ts";
import { collectPostPushStepIds, findRepoRemediationStepId, isGitWorkflow } from "./git-pipeline.ts";
import { orderedStepIds } from "./graph.ts";
import type { WorkflowDefinition, WorkflowMetadata, WorkflowSummary } from "./types.ts";

export async function listWorkflowSummaries(root: string): Promise<WorkflowSummary[]> {
  const workflows = await loadAllWorkflows(root);
  return [...workflows.values()]
    .map((workflow) => {
      const remediationStepId = isGitWorkflow(workflow) ? findRepoRemediationStepId(workflow) : null;
      return {
        id: workflow.id,
        name: workflow.name,
        initial: workflow.initial,
        stepIds: orderedStepIds(workflow),
        steps: Object.fromEntries(
          Object.entries(workflow.steps).map(([id, step]) => [
            id,
            {
              kind: step.kind,
              agent: step.agent,
              approval: step.approval,
              ...(step.skill ? { skill: step.skill } : {}),
              ...(step.effort ? { effort: step.effort } : {}),
              ...(step.next ? { next: step.next } : {}),
              ...(step.parallel ? { parallel: step.parallel } : {}),
              ...(step.join ? { join: step.join } : {}),
              ...(step.branch ? { branch: step.branch } : {}),
              ...(step.reviewProfile ? { reviewProfile: step.reviewProfile } : {}),
              ...(step.modifiesRepo !== undefined ? { modifiesRepo: step.modifiesRepo } : {})
            }
          ])
        ),
        defaults: workflow.defaults,
        ...(remediationStepId
          ? {
              gitPipeline: {
                remediationStepId,
                postPushStepIds: [...collectPostPushStepIds(workflow)]
              }
            }
          : {})
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function toWorkflowMetadata(
  root: string,
  workflow: WorkflowDefinition,
  overrides?: StageAgentOverrides
): Promise<WorkflowMetadata> {
  const { buildResolvedStageAgents, loadStageAgentOverrides } = await import("../agents/stage-agents.ts");
  const { loadHarnessSettings } = await import("../settings.ts");
  const [stageOverrides, settings] = await Promise.all([
    overrides ? Promise.resolve(overrides) : loadStageAgentOverrides(root),
    loadHarnessSettings(root)
  ]);
  const stageAgents = buildResolvedStageAgents(workflow, stageOverrides, settings.defaultAgent);
  return {
    id: workflow.id,
    name: workflow.name,
    initial: workflow.initial,
    defaults: workflow.defaults,
    steps: Object.fromEntries(
      Object.entries(workflow.steps).map(([id, step]) => [
        id,
        {
          kind: step.kind,
          agent: step.agent,
          ...(step.skill ? { skill: step.skill } : {}),
          ...(step.effort ? { effort: step.effort } : {}),
          approval: step.approval,
          ...(step.next ? { next: step.next } : {}),
          ...(step.branch ? { branch: step.branch } : {})
        }
      ])
    ),
    stageAgents: stageAgents.map((entry) => ({
      stage: entry.stage,
      role: entry.role,
      agent: entry.agent,
      source: entry.source,
      ...(entry.override ? { override: entry.override } : {})
    }))
  };
}