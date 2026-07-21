import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EvalCase } from "../evals/types.ts";
import { readJsonFile } from "../infra/fs.ts";
import { hashBody } from "../inventory/hash.ts";
import { packageRoot } from "../inventory/paths.ts";
import { inventoryWorkflows } from "../inventory/workflows.ts";
import { readPackageMeta } from "../system/version.ts";
import { workflowsDir } from "../workflows/paths.ts";
import { validateWorkflow } from "../workflows/validate.ts";
import type { HarnessTask } from "../types.ts";
import { provisionalQualityFloors } from "./floors.ts";
import { computeBaselineId } from "./id.ts";
import { aggregateTaskMetrics } from "./metrics.ts";
import { observeHistoricalCases, replayEvalCorpus } from "./replay.ts";
import type {
  BaselineReport,
  BuildBaselineReportInput,
  HistoricalCaseObservation,
  SpotCheckFieldComparison,
  SpotCheckReport
} from "./types.ts";

export const SPOT_CHECK_CASE_ID = "small-api-guard";

export const PHASE2_UNSUPPORTED_METRICS = [
  "normalized per-run input/output token counts",
  "cost per accepted outcome (USD)",
  "subscription-equivalent cost attribution",
  "quality-first routing decision log",
  "capability profile scores per model pool",
  "automated rubric scoring (LLM judge)",
  "champion/challenger promotion gate evaluation",
  "per-step model identity attribution across turns",
  "quota exhaustion predictive alerts"
] as const;

async function workflowHashes(root: string): Promise<Record<string, string>> {
  const { runtimeDefinitions } = await inventoryWorkflows(root);
  const hashes: Record<string, string> = {};
  const dir = workflowsDir(root);
  for (const [workflowId, definition] of runtimeDefinitions.entries()) {
    const filePath = path.join(dir, `${workflowId}.yml`);
    try {
      const text = await readFile(filePath, "utf8");
      hashes[workflowId] = hashBody(text);
    } catch {
      hashes[workflowId] = hashBody(JSON.stringify(validateWorkflow(definition)));
    }
  }
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))
  );
}

function formatRate(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function findSpotCheckEvalCase(corpus: BuildBaselineReportInput["corpus"]): EvalCase | undefined {
  const entry = corpus.cases.find(
    (candidate) => !candidate.errors.length && candidate.case?.id === SPOT_CHECK_CASE_ID
  );
  return entry?.case ?? undefined;
}

function findCandidateRuntimeTask(tasks: HarnessTask[], evalCase: EvalCase): HarnessTask | undefined {
  // Require workflow + title match so we never compare against an unrelated task
  // that happens to share the workflow id.
  return tasks.find(
    (task) =>
      task.workflowRun?.workflowId === evalCase.workflowId &&
      task.title === evalCase.inputs.title
  );
}

function findHistoricalRuntimeTask(tasks: HarnessTask[], evalCase: EvalCase): HarnessTask | undefined {
  const sourceHash = evalCase.provenance.source.match(/^runtime-task-sha256:([a-f0-9]+)$/)?.[1];
  if (!sourceHash) return undefined;
  return tasks.find(
    (task) => task.workflowRun?.workflowId === evalCase.workflowId && hashBody(task.id).startsWith(sourceHash)
  );
}

function summarizeDeterministicChecks(evalCase: EvalCase): string {
  return (evalCase.outcome.deterministicChecks ?? [])
    .map((check) => {
      if (check.kind === "checks-outcome") return `checks-outcome:${check.outcome}`;
      if (check.kind === "workflow-step") return `workflow-step:${check.stepId}`;
      return check.kind;
    })
    .join(", ");
}

function evaluateRuntimeDeterministicChecks(
  evalCase: EvalCase,
  runtimeTask: HarnessTask
): { matches: boolean; summary: string } {
  const notes: string[] = [];
  let matches = true;

  for (const check of evalCase.outcome.deterministicChecks ?? []) {
    if (check.kind === "checks-outcome" && check.outcome === "validated") {
      const ok = !runtimeTask.lastCheckFailure;
      if (!ok) matches = false;
      notes.push(`checks-outcome validated: lastCheckFailure ${ok ? "absent" : "present"}`);
      continue;
    }

    if (check.kind === "workflow-step" && check.stepId) {
      const reached =
        runtimeTask.workflowRun?.currentStepId === check.stepId ||
        runtimeTask.workflowRun?.completedSteps.includes(check.stepId) === true;
      if (!reached) matches = false;
      notes.push(`workflow-step ${check.stepId}: ${reached ? "reached" : "not reached"}`);
    }
  }

  return { matches, summary: notes.join("; ") || "n/a" };
}

export function buildSpotCheck(
  observation: HistoricalCaseObservation | undefined,
  evalCase: EvalCase | undefined,
  tasks: HarnessTask[]
): SpotCheckReport | undefined {
  if (!observation || !evalCase) return undefined;

  const runtimeTask = evalCase.provenance.kind === "historical"
    ? findHistoricalRuntimeTask(tasks, evalCase)
    : findCandidateRuntimeTask(tasks, evalCase);
  const fieldsCompared: SpotCheckFieldComparison[] = [
    {
      field: "workflowId",
      fixtureValue: evalCase.workflowId,
      ...(runtimeTask?.workflowRun?.workflowId !== undefined
        ? { runtimeValue: runtimeTask.workflowRun.workflowId }
        : {}),
      status: !runtimeTask
        ? "no-runtime-task"
        : runtimeTask.workflowRun?.workflowId === evalCase.workflowId
          ? "match"
          : "mismatch"
    },
    {
      field: "taskClass",
      fixtureValue: evalCase.taskClass,
      status: "fixture-only",
      note: "Scope pattern metadata; no direct harness task field."
    },
    {
      field: "risk",
      fixtureValue: evalCase.risk,
      status: "fixture-only",
      note: "Used for quality floor lookup; not stored on runtime tasks."
    },
    {
      field: "provenance.kind",
      fixtureValue: evalCase.provenance.kind,
      status: "fixture-only",
      note: runtimeTask
        ? evalCase.provenance.kind === "historical"
          ? "Matched by the privacy-reviewed source task hash."
          : "Fixture is pattern-synthesized; runtime task id is not expected to match archived sources."
        : evalCase.provenance.kind === "historical"
          ? "No runtime task matched the privacy-reviewed source task hash."
          : "Pattern-synthesized fixture; no live task id archived."
    },
    {
      field: "inputs.title",
      fixtureValue: evalCase.inputs.title,
      ...(runtimeTask?.title !== undefined ? { runtimeValue: runtimeTask.title } : {}),
      status: !runtimeTask
        ? "no-runtime-task"
        : runtimeTask.title === evalCase.inputs.title
          ? "match"
          : "mismatch",
      ...(runtimeTask && runtimeTask.title !== evalCase.inputs.title
        ? { note: "Title differs; matched runtime task by workflow only." }
        : {})
    }
  ];

  const deterministicFixtureValue = summarizeDeterministicChecks(evalCase);
  if (runtimeTask) {
    const deterministic = evaluateRuntimeDeterministicChecks(evalCase, runtimeTask);
    fieldsCompared.push({
      field: "outcome.deterministicChecks",
      fixtureValue: deterministicFixtureValue,
      runtimeValue: deterministic.summary,
      status: deterministic.matches ? "match" : "mismatch"
    });
  } else {
    fieldsCompared.push({
      field: "outcome.deterministicChecks",
      fixtureValue: deterministicFixtureValue,
      status: "no-runtime-task",
      note: "Expect lastCheckFailure absent and workflow reached handoff when a matching task exists."
    });
  }

  fieldsCompared.push({
    field: "outcome.rubric",
    fixtureValue: (evalCase.outcome.rubric ?? []).map((item) => item.id).join(", "),
    status: "fixture-only",
    note: "Manual / Phase 2 rubric scoring; not auto-scored in Phase 0."
  });

  const comparable = fieldsCompared.filter((field) => field.status !== "fixture-only");
  const matched = comparable.filter((field) => field.status === "match").length;
  const notes = runtimeTask
    ? `Compared fixture ${evalCase.id} against runtime task ${runtimeTask.id} (${matched}/${comparable.length} comparable fields match).`
    : `Inspected fixture ${evalCase.id} fields; no matching runtime task found in harness.`;

  return {
    caseId: observation.caseId,
    fixturePath: `tests/evals/cases/v1/${evalCase.workflowId}/${evalCase.id}.json`,
    runtimeTaskFound: Boolean(runtimeTask),
    ...(runtimeTask?.id !== undefined ? { matchingRuntimeTaskId: runtimeTask.id } : {}),
    fieldsCompared,
    notes
  };
}

export async function buildBaselineReport(input: BuildBaselineReportInput): Promise<BaselineReport> {
  const { root, inventory, corpus, command = "baseline-report" } = input;
  const tasks =
    input.tasks ??
    (await readJsonFile(path.join(root, "data", "state", "tasks.json"), []));
  const corpusReplay = await replayEvalCorpus(root, corpus);
  const hashes = await workflowHashes(root);
  const validCaseIds = corpus.cases
    .filter((entry) => !entry.errors.length && entry.case)
    .map((entry) => entry.case!.id);
  const caseFingerprints = Object.fromEntries(
    corpus.cases
      .filter((entry) => !entry.errors.length && entry.case)
      .map((entry) => [entry.case!.id, hashBody(JSON.stringify(entry.case))])
  );
  const modelIdentities = {
    defaultAgent: inventory.settings.defaultAgent,
    modelPools: inventory.modelPools.map((pool) => ({
      id: pool.id,
      toolId: pool.toolId,
      tier: pool.tier,
      enabled: pool.enabled,
      modelArgs: [...pool.modelArgs]
    })),
    stageOverrides: inventory.stageOverrides,
    stageModelPoolOverrides: inventory.stageModelPoolOverrides
  };
  const skillHashes = Object.fromEntries(
    inventory.skills
      .filter((skill) => skill.bodyHash)
      .map((skill) => [skill.id, skill.bodyHash!])
  );
  const baselineId = computeBaselineId({
    corpusVersion: corpus.version,
    caseIds: validCaseIds,
    workflowHashes: hashes,
    skillHashes,
    modelIdentities,
    caseFingerprints
  });
  const allObservations = observeHistoricalCases(corpus);
  const spotCheckCase = allObservations.find(
    (observation) => observation.caseId === SPOT_CHECK_CASE_ID
  );
  const spotCheckEvalCase = findSpotCheckEvalCase(corpus);
  const spotCheck = buildSpotCheck(spotCheckCase, spotCheckEvalCase, tasks);
  const historicalSpotCheckCase = corpusReplay.historicalObservations.cases[0];
  const historicalSpotCheckEvalCase = historicalSpotCheckCase
    ? corpus.cases.find((entry) => entry.case?.id === historicalSpotCheckCase.caseId)?.case ?? undefined
    : undefined;
  const historicalSpotCheck = buildSpotCheck(historicalSpotCheckCase, historicalSpotCheckEvalCase, tasks);
  const packageMeta = await readPackageMeta(packageRoot());

  return {
    schemaVersion: 1,
    metricsVersion: "1",
    baselineId,
    generatedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      command,
      packageName: packageMeta.name,
      packageVersion: packageMeta.version
    },
    corpusVersion: corpus.version,
    workflowHashes: hashes,
    skillHashes,
    modelIdentities,
    runtimeTaskMetrics: aggregateTaskMetrics(tasks),
    corpusReplay,
    usage: {
      inputTokens: "unknown",
      outputTokens: "unknown",
      costUsd: "unknown",
      quotaSnapshots: inventory.usageSnapshots
    },
    qualityFloors: provisionalQualityFloors(),
    phase2UnsupportedMetrics: [...PHASE2_UNSUPPORTED_METRICS],
    ...(spotCheck ? { spotCheck } : {}),
    ...(historicalSpotCheck ? { historicalSpotCheck } : {})
  };
}

export function renderBaselineMarkdown(report: BaselineReport): string {
  const lines: string[] = [
    `# Baseline report ${report.baselineId}`,
    "",
    `- Generated: ${report.generatedAt}`,
    `- Corpus: ${report.corpusVersion}`,
    `- Command: ${report.environment.command}`,
    `- Package: ${report.environment.packageName ?? "unknown"}@${report.environment.packageVersion ?? "unknown"}`,
    `- Node: ${report.environment.nodeVersion} (${report.environment.platform})`,
    `- Default agent: ${report.modelIdentities.defaultAgent}`,
    `- Model pools: ${report.modelIdentities.modelPools
      .map((pool) => `${pool.id}[${pool.modelArgs.join(" ") || "default"}]`)
      .join(", ") || "n/a"}`,
    `- Workflow hashes: ${Object.keys(report.workflowHashes).length} recorded`,
    `- Skill hashes: ${Object.keys(report.skillHashes).length} recorded`,
    "",
    "## Runtime task metrics",
    "",
    `- Tasks: ${report.runtimeTaskMetrics.total}`,
    `- Completed: ${report.runtimeTaskMetrics.completed}`,
    `- Failed: ${report.runtimeTaskMetrics.failed}`,
    `- Cancelled: ${report.runtimeTaskMetrics.cancelled}`,
    `- Retried: ${report.runtimeTaskMetrics.retried}`,
    `- Reviewed: ${report.runtimeTaskMetrics.reviewed}`,
    `- Accepted outcome rate: ${formatRate(report.runtimeTaskMetrics.rates.acceptedOutcome)}`,
    `- Deterministic pass rate: ${formatRate(report.runtimeTaskMetrics.rates.deterministicPass)}`,
    `- First-pass review acceptance: ${formatRate(report.runtimeTaskMetrics.rates.firstPassReviewAccepted)}`,
    `- CompletedAt without success: ${report.runtimeTaskMetrics.withCompletedAtButNotSuccessful}`,
    `- Avg review rounds: ${report.runtimeTaskMetrics.averages.reviewRounds.toFixed(2)}`,
    `- Avg operator interventions: ${report.runtimeTaskMetrics.averages.operatorInterventions.toFixed(2)}`,
    `- Avg tool retries: ${report.runtimeTaskMetrics.averages.toolRetries.toFixed(2)}`,
    `- Avg wall time: ${formatMs(report.runtimeTaskMetrics.averages.wallTimeMs)}`,
    "",
    "## Corpus historical observations",
    "",
    `- Historical cases: ${report.corpusReplay.historicalObservations.caseCount}`,
    `- By workflow: ${Object.entries(report.corpusReplay.historicalObservations.byWorkflow)
      .map(([workflowId, count]) => `${workflowId}=${count}`)
      .join(", ") || "n/a"}`,
    "",
    "## Corpus fresh replay",
    "",
    `- Cases replayed: ${report.corpusReplay.freshReplay.caseCount}`,
    `- Structural pass: ${report.corpusReplay.freshReplay.passed}`,
    `- Structural fail: ${report.corpusReplay.freshReplay.failed}`,
    `- Unsupported replay checks: ${report.corpusReplay.freshReplay.unsupportedChecks}`,
    "",
    "## Usage and cost",
    "",
    `- Input tokens: ${report.usage.inputTokens}`,
    `- Output tokens: ${report.usage.outputTokens}`,
    `- Cost (USD): ${report.usage.costUsd}`,
    `- Quota snapshots: ${report.usage.quotaSnapshots.snapshots.length}`,
    "",
    "## Provisional quality floors",
    ""
  ];

  for (const entry of report.qualityFloors.filter((floor) => floor.capability === "default")) {
    lines.push(
      `- ${entry.risk}: accepted ${(entry.floor.minAcceptedOutcomeRate * 100).toFixed(0)}%, deterministic ${(entry.floor.minDeterministicPassRate * 100).toFixed(0)}%, first-pass review ${(entry.floor.minFirstPassReviewRate * 100).toFixed(0)}%`
    );
  }

  const defaultFloors = new Map(
    report.qualityFloors
      .filter((floor) => floor.capability === "default")
      .map((floor) => [floor.risk, floor.floor])
  );
  const capabilityOverrides = report.qualityFloors.filter((floor) => {
    if (floor.capability === "default") return false;
    const baseline = defaultFloors.get(floor.risk);
    return !baseline || JSON.stringify(floor.floor) !== JSON.stringify(baseline);
  });
  if (capabilityOverrides.length) {
    lines.push("", "### Capability overrides", "");
    for (const entry of capabilityOverrides) {
      lines.push(
        `- ${entry.capability} (${entry.risk}): accepted ${(entry.floor.minAcceptedOutcomeRate * 100).toFixed(0)}%, deterministic ${(entry.floor.minDeterministicPassRate * 100).toFixed(0)}%, first-pass review ${(entry.floor.minFirstPassReviewRate * 100).toFixed(0)}%`
      );
    }
  }

  lines.push("", "## Phase 2 unsupported metrics", "");
  for (const metric of report.phase2UnsupportedMetrics) {
    lines.push(`- ${metric}`);
  }

  if (report.spotCheck) {
    lines.push(
      "",
      "## Manual spot-check",
      "",
      `- Case: ${report.spotCheck.caseId}`,
      `- Fixture: ${report.spotCheck.fixturePath}`,
      `- Runtime task found: ${report.spotCheck.runtimeTaskFound ? "yes" : "no"}`,
      ...(report.spotCheck.matchingRuntimeTaskId
        ? [`- Matching runtime task: ${report.spotCheck.matchingRuntimeTaskId}`]
        : []),
      `- ${report.spotCheck.notes}`,
      ""
    );
    for (const field of report.spotCheck.fieldsCompared) {
      const runtime = field.runtimeValue ? ` → runtime: ${field.runtimeValue}` : "";
      const note = field.note ? ` (${field.note})` : "";
      lines.push(`- ${field.field}: fixture=${field.fixtureValue}${runtime} [${field.status}]${note}`);
    }
  }

  if (report.historicalSpotCheck) {
    lines.push(
      "",
      "## Historical spot-check",
      "",
      `- Case: ${report.historicalSpotCheck.caseId}`,
      `- Fixture: ${report.historicalSpotCheck.fixturePath}`,
      `- Runtime task found: ${report.historicalSpotCheck.runtimeTaskFound ? "yes" : "no"}`,
      ...(report.historicalSpotCheck.matchingRuntimeTaskId
        ? [`- Matching runtime task: ${report.historicalSpotCheck.matchingRuntimeTaskId}`]
        : []),
      `- ${report.historicalSpotCheck.notes}`,
      ""
    );
    for (const field of report.historicalSpotCheck.fieldsCompared) {
      const runtime = field.runtimeValue ? ` → runtime: ${field.runtimeValue}` : "";
      const note = field.note ? ` (${field.note})` : "";
      lines.push(`- ${field.field}: fixture=${field.fixtureValue}${runtime} [${field.status}]${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeBaselineReport(
  report: BaselineReport,
  outDir = path.join(process.cwd(), "tmp")
): Promise<{ jsonPath: string; markdownPath: string }> {
  const { ensureDir } = await import("../infra/fs.ts");
  const { writeFile } = await import("node:fs/promises");
  await ensureDir(outDir);
  const jsonPath = path.join(outDir, `${report.baselineId}.json`);
  const markdownPath = path.join(outDir, `${report.baselineId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderBaselineMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
