import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../../runners/types.ts";
import { createTask, getTask, updateTask } from "../tasks/tasks.ts";
import { listAllRuns } from "../tasks/runs.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { advanceTaskWorkflowStep } from "../tasks/tasks.ts";
import { inventoryWorkflows } from "../inventory/workflows.ts";
import { replayArtifactPaths, replayChecksWorkspacePath, replayReviewerReply, resolveEvalFixturePath } from "../evals/replay-fixtures.ts";
import type { EvalCase, EvalCorpus } from "../evals/types.ts";
import { artifactPathMatches } from "../evals/check-kinds.ts";
import { runChecks } from "../review/checks.ts";
import { parseReviewerVerdict } from "../review/code-review.ts";
import { findArtifactProducingStepId } from "../workflows/graph.ts";
import { resetWorkflowCache } from "../workflows/cache.ts";
import type { WorkflowDefinition } from "../workflows/types.ts";
import type {
  CorpusReplayReport,
  CorpusReplaySummary,
  EvalCaseReplayResult,
  HistoricalCaseObservation,
  HistoricalObservationSummary,
  ReplayCheckResult
} from "./types.ts";

const COVERAGE_TASK_CLASSES = new Set(["small", "medium", "failure", "decomposition", "acceptance-contract"]);

function summarizeHistoricalObservations(observations: HistoricalCaseObservation[]): HistoricalObservationSummary {
  const historical = observations.filter((observation) => observation.provenanceKind === "historical");
  const byWorkflow: Record<string, number> = {};
  const byRisk: HistoricalObservationSummary["byRisk"] = { low: 0, medium: 0, high: 0 };
  for (const observation of historical) {
    byWorkflow[observation.workflowId] = (byWorkflow[observation.workflowId] ?? 0) + 1;
    byRisk[observation.risk] += 1;
  }
  return { caseCount: historical.length, byWorkflow, byRisk, cases: historical };
}

export function observeHistoricalCase(evalCase: EvalCase): HistoricalCaseObservation {
  return {
    caseId: evalCase.id,
    workflowId: evalCase.workflowId,
    taskClass: evalCase.taskClass,
    risk: evalCase.risk,
    provenanceKind: evalCase.provenance.kind,
    source: evalCase.provenance.source,
    contextHints: evalCase.inputs.context ?? {},
    deterministicCheckCount: evalCase.outcome.deterministicChecks?.length ?? 0,
    rubricItemCount: evalCase.outcome.rubric?.length ?? 0
  };
}

export function observeHistoricalCases(corpus: EvalCorpus): HistoricalCaseObservation[] {
  return corpus.cases
    .filter((entry) => !entry.errors.length && entry.case && COVERAGE_TASK_CLASSES.has(entry.case.taskClass))
    .map((entry) => observeHistoricalCase(entry.case!))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
}

class DeterministicReplayRunner implements AgentRunner {
  readonly agent = "replay";
  readonly prompts: Array<{ stepId?: string; mode: string; promptLength: number }> = [];
  readonly artifacts: string[] = [];
  readonly reviewerReplies: string[] = [];
  readonly reviewerDecisions: string[] = [];
  private readonly artifactPaths: string[];

  constructor(
    private readonly evalCase: EvalCase,
    private readonly artifactStepIds: ReadonlySet<string>,
    private readonly reviewerReply?: string
  ) {
    this.artifactPaths = replayArtifactPaths(evalCase) ?? [];
  }

  abort(): void {}

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.prompts.push({
      ...(request.task.workflowRun?.currentStepId ? { stepId: request.task.workflowRun.currentStepId } : {}),
      mode: request.mode ?? "execute",
      promptLength: request.prompt.length
    });
    const stepId = request.task.workflowRun?.currentStepId;
    for (const relative of stepId && this.artifactStepIds.has(stepId) ? this.artifactPaths : []) {
      const cwd = path.resolve(request.cwd);
      const file = path.resolve(cwd, relative);
      if (file !== cwd && !file.startsWith(`${cwd}${path.sep}`)) {
        throw new Error(`Replay artifact path escapes the task workspace: ${relative}`);
      }
      await mkdir(path.dirname(file), { recursive: true });
      const body = this.evalCase.id.startsWith("profiled-release-brief-")
        ? "# Release brief\n\nAdoption increased by 42%. No supporting source is attached.\n"
        : `Replay artifact for ${this.evalCase.id}\n`;
      await writeFile(file, body, "utf8");
      if (!this.artifacts.includes(relative)) this.artifacts.push(relative);
    }
    const isReview = /Review profile:|You are the \*reviewer\*/i.test(request.prompt);
    const reply = isReview
      ? this.reviewerReplyForRequest(request.prompt)
      : request.mode === "plan"
        ? `<proposed_plan>\n# Replay investigation\n\nEvidence and next steps.\n\n## Acceptance Criteria\nReplay artifact is accepted by the reviewer.\n## Verification\nReviewer verdict is "approve".\n## Risks\nNone.\n## Reproduction\nReplay workflow run.\n## Root Cause\nReplay investigation root cause.\n## Evidence\nReplay artifact evidence recorded.\n## Affected Surface\nReplay workspace.\n## Test Strategy\nReviewer approves the artifact.\n## Confidence\nhigh\n</proposed_plan>`
        : "**Completed.** Replay execution evidence recorded.";
    return {
      reply,
      sessionId: `replay-${request.task.id}`,
      exitCode: 0,
      command: "deterministic-replay",
      rawLog: `${reply}\nPrompt length: ${request.prompt.length}\n`
    };
  }

  private reviewerReplyForRequest(prompt: string): string {
    const configured = this.reviewerReply;
    const first = this.reviewerReplies.length === 0;
    const profile = prompt.match(/Review profile: `([^`]+)`/i)?.[1];
    const profileReply = profile === "data" && first
      ? JSON.stringify({
          decision: "request_changes",
          summary: "Numeric claims need bounded evidence.",
          comments: [{
            severity: "HIGH",
            category: "DATA_INTEGRITY",
            title: "Unsupported metric",
            rationale: "The release brief does not include evidence for its number."
          }]
        })
      : JSON.stringify({ decision: "approve", summary: "Replay profile accepted the artifact.", comments: [] });
    const reply = configured
      ? first || parseReviewerVerdict(configured).decision !== "changes_requested"
        ? configured
        : JSON.stringify({ decision: "approve", summary: "Replay remediation accepted.", comments: [] })
      : profileReply;
    this.reviewerReplies.push(reply);
    this.reviewerDecisions.push(parseReviewerVerdict(reply).decision);
    return reply;
  }
}

async function replayRootFromRuntime(root: string): Promise<string> {
  const replayRoot = await mkdtemp(path.join(os.tmpdir(), "mission-control-replay-"));
  await ensureHarnessRepository(replayRoot);
  await cp(path.join(root, "workflows"), path.join(replayRoot, "workflows"), { recursive: true, force: true });
  await cp(path.join(root, "skills"), path.join(replayRoot, "skills"), { recursive: true, force: true });
  for (const name of ["agent-config.json", "settings.json", "stage-agents.json", "stage-model-pools.json"]) {
    await cp(path.join(root, "data", "state", name), path.join(replayRoot, "data", "state", name), { force: true }).catch(() => {});
  }
  return replayRoot;
}

async function cloneReplayRoot(templateRoot: string): Promise<string> {
  const replayRoot = await mkdtemp(path.join(os.tmpdir(), "mission-control-replay-case-"));
  await mkdir(path.join(replayRoot, "data", "runs"), { recursive: true });
  await cp(path.join(templateRoot, "data", "state"), path.join(replayRoot, "data", "state"), { recursive: true });
  for (const directory of ["kernel", "skills", "workflows"]) {
    await cp(path.join(templateRoot, directory), path.join(replayRoot, directory), { recursive: true });
  }
  return replayRoot;
}

async function prepareReplayWorkspace(replayRoot: string, evalCase: EvalCase): Promise<string> {
  const workspace = path.join(replayRoot, "workspace", evalCase.id);
  await mkdir(workspace, { recursive: true });
  const fixture = replayChecksWorkspacePath(evalCase);
  if (fixture) {
    await cp(resolveEvalFixturePath(fixture), workspace, { recursive: true, force: true });
  }
  return workspace;
}

async function approveReplaySteps(root: string, taskId: string, workflow: WorkflowDefinition): Promise<void> {
  await updateTask(root, taskId, (task) => {
    if (!task.workflowRun) {
      return { ...task, approvedAt: task.approvedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    return {
      ...task,
      approvedAt: task.approvedAt ?? new Date().toISOString(),
      workflowRun: {
        ...task.workflowRun,
        stepApprovals: Object.fromEntries(
          Object.keys(workflow.steps).map((stepId) => [stepId, { stepId, status: "approved", approvedAt: new Date().toISOString() }])
        )
      },
      updatedAt: new Date().toISOString()
    };
  });
}

async function runtimeReplay(
  root: string,
  evalCase: EvalCase,
  workflow: WorkflowDefinition,
  templateRoot?: string
): Promise<{
  result: EvalCaseReplayResult;
  runner: DeterministicReplayRunner;
}> {
  const replayRoot = templateRoot ? await cloneReplayRoot(templateRoot) : await replayRootFromRuntime(root);
  const reviewStepIds = Object.entries(workflow.steps)
    .filter(([, step]) => step.kind === "review")
    .map(([stepId]) => stepId);
  const artifactStepIds = new Set(
    reviewStepIds
      .map((stepId) => findArtifactProducingStepId(workflow, stepId))
      .filter((stepId): stepId is string => Boolean(stepId))
  );
  if (!artifactStepIds.size) artifactStepIds.add(workflow.initial);
  const runner = new DeterministicReplayRunner(evalCase, artifactStepIds, await replayReviewerReply(evalCase));
  const errors: string[] = [];
  try {
    const workspace = await prepareReplayWorkspace(replayRoot, evalCase);
    const task = await createTask(replayRoot, {
      title: evalCase.inputs.title,
      description: evalCase.inputs.description,
      workflowId: evalCase.workflowId,
      source: "manual",
      links: [],
      targets: [{ raw: "@replay-workspace", path: workspace, kind: "directory" }]
    });
    await approveReplaySteps(replayRoot, task.id, workflow);
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const current = await getTask(replayRoot, task.id);
      const stepId = current?.workflowRun?.currentStepId;
      if (!current || !stepId) break;
      const step = workflow.steps[stepId];
      if (!step || step.kind === "terminal") break;
      if (step.kind === "create_merge_request") {
        await updateTask(replayRoot, task.id, (current) => ({
          ...current,
          mergeRequest: { provider: "github", url: "https://replay.invalid/merge-request/1", number: 1, state: "open" },
          updatedAt: new Date().toISOString()
        }));
        await advanceTaskWorkflowStep(replayRoot, task.id);
        continue;
      }
      if (step.kind === "resolve_conflicts") {
        await advanceTaskWorkflowStep(replayRoot, task.id);
        continue;
      }
      const { runTaskTurn } = await import("../../daemon/processor.ts");
      const summary = await runTaskTurn(replayRoot, task.id, {
        runner,
        wait: true,
        replayExternalSteps: true
      });
      const after = await getTask(replayRoot, task.id);
      // A turn that drives a review→remediation→review cycle ends on the same
      // step it started on; treat that as progress as long as turnCount moved.
      const turnProgressed = (after?.turnCount ?? 0) > (current?.turnCount ?? 0);
      if (summary?.execution === "blocked" || !after || (!turnProgressed && after.workflowRun?.currentStepId === stepId)) {
        errors.push(after?.blockedReason ?? `Replay stalled at step "${stepId}".`);
        break;
      }
    }
    const finalTask = await getTask(replayRoot, task.id);
    const terminal = finalTask?.workflowRun?.currentStepId === Object.keys(workflow.steps).find((id) => workflow.steps[id]?.kind === "terminal");
    const checks: ReplayCheckResult[] = [];
    for (const check of evalCase.outcome.deterministicChecks ?? []) {
      if (check.kind === "workflow-step") {
        const reached = Boolean(finalTask?.workflowRun?.completedSteps.includes(check.stepId ?? "") || finalTask?.workflowRun?.currentStepId === check.stepId);
        checks.push({ kind: check.kind, status: reached ? "passed" : "failed", ...(reached ? {} : { message: `Step "${check.stepId}" was not reached.` }) });
      } else if (check.kind === "artifact-present") {
        const paths = runner.artifacts;
        if (!paths.length) checks.push({ kind: check.kind, status: "unsupported", message: "Runtime replay produced no declared artifact path." });
        else checks.push({ kind: check.kind, status: artifactPathMatches(check.pathPattern ?? "", paths) ? "passed" : "failed" });
      } else if (check.kind === "checks-outcome") {
        const summary = await runChecks(workspace);
        checks.push({ kind: check.kind, status: summary.outcome === check.outcome ? "passed" : "failed" });
      } else if (check.kind === "reviewer-verdict") {
        if (!runner.reviewerReplies.length) {
          checks.push({ kind: check.kind, status: "unsupported", message: "Reviewer replay requires a deterministic runner reply fixture." });
        } else {
          const reply = runner.reviewerReplies.at(-1) ?? "";
          const parsed = parseReviewerVerdict(reply);
          const expected = check.decision === "approved" ? "approved" : "changes_requested";
          const actual = expected === "changes_requested"
            ? runner.reviewerDecisions.includes("changes_requested")
              ? "changes_requested"
              : parsed.decision
            : parsed.decision;
          checks.push({ kind: check.kind, status: actual === expected ? "passed" : "failed" });
        }
      } else {
        checks.push({ kind: check.kind, status: "unsupported", message: `Unsupported check kind "${check.kind}".` });
      }
    }
    if (!terminal) errors.push("Runtime replay did not reach the workflow terminal state.");
    const counters = {
      total: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      failed: checks.filter((check) => check.status === "failed").length,
      unsupported: checks.filter((check) => check.status === "unsupported").length
    };
    return {
      runner,
      result: {
        caseId: evalCase.id,
        workflowId: evalCase.workflowId,
        provenanceKind: evalCase.provenance.kind,
        structuralChecks: counters,
        checks,
        passed: terminal && counters.failed === 0 && counters.unsupported === 0 && errors.length === 0,
        errors,
        runtime: {
          terminal,
          attempts: runner.prompts.length,
          routingChoices: (await listAllRuns(replayRoot)).map((run) => ({
            ...(run.stepId ? { stepId: run.stepId } : {}),
            agent: run.agent,
            ...(run.modelPoolId ? { modelPoolId: run.modelPoolId } : {}),
            ...(run.stepId && finalTask
              ? (() => {
                  const effort =
                    run.effort ??
                    finalTask.stageEffortOverrides?.[run.stepId] ??
                    finalTask.effort;
                  return effort ? { effort } : {};
                })()
              : {})
          })),
          artifacts: runner.artifacts,
          reviewerVerdict: finalTask?.reviewState ?? "none",
          reviewerDecisions: runner.reviewerDecisions
        }
      }
    };
  } finally {
    resetWorkflowCache(replayRoot);
    await rm(replayRoot, { recursive: true, force: true });
  }
}

export async function replayEvalCase(
  evalCase: EvalCase,
  workflows: ReadonlyMap<string, WorkflowDefinition>,
  root?: string,
  templateRoot?: string
): Promise<EvalCaseReplayResult> {
  const workflow = workflows.get(evalCase.workflowId);
  if (!workflow) {
    return {
      caseId: evalCase.id,
      workflowId: evalCase.workflowId,
      provenanceKind: evalCase.provenance.kind,
      structuralChecks: { total: evalCase.outcome.deterministicChecks?.length ?? 0, passed: 0, failed: evalCase.outcome.deterministicChecks?.length ?? 0, unsupported: 0 },
      checks: [],
      passed: false,
      errors: [`Workflow "${evalCase.workflowId}" is not available in the runtime inventory.`]
    };
  }
  if (!root) {
    return {
      caseId: evalCase.id,
      workflowId: evalCase.workflowId,
      provenanceKind: evalCase.provenance.kind,
      structuralChecks: { total: 0, passed: 0, failed: 0, unsupported: 1 },
      checks: [{ kind: "runtime", status: "unsupported", message: "A harness root is required for runtime replay." }],
      passed: false,
      errors: ["A harness root is required for runtime replay."]
    };
  }
  return (await runtimeReplay(root, evalCase, workflow, templateRoot)).result;
}

function summarizeFreshReplay(results: EvalCaseReplayResult[]): CorpusReplaySummary {
  return {
    caseCount: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    unsupportedChecks: results.reduce((sum, result) => sum + result.structuralChecks.unsupported, 0),
    results
  };
}

export async function replayEvalCorpus(root: string, corpus: EvalCorpus): Promise<CorpusReplayReport> {
  const { runtimeDefinitions } = await inventoryWorkflows(root);
  const historicalObservations = summarizeHistoricalObservations(observeHistoricalCases(corpus));
  const templateRoot = await replayRootFromRuntime(root);
  try {
    const entries = corpus.cases.filter((entry) => !entry.errors.length && entry.case);
    const freshResults: EvalCaseReplayResult[] = [];
    let nextIndex = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex++;
        const entry = entries[index];
        if (!entry) return;
        freshResults.push(await replayEvalCase(entry.case!, runtimeDefinitions, root, templateRoot));
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
    freshResults.sort((left, right) => left.caseId.localeCompare(right.caseId));
    return { historicalObservations, freshReplay: summarizeFreshReplay(freshResults) };
  } finally {
    resetWorkflowCache(templateRoot);
    await rm(templateRoot, { recursive: true, force: true });
  }
}
