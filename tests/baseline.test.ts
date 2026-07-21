import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionalQualityFloors } from "../src/core/baseline/floors.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { ensureDir } from "../src/core/infra/fs.ts";
import { loadEvalCorpus } from "../src/core/evals/index.ts";
import {
  aggregateTaskMetrics,
  buildSpotCheck,
  computeBaselineId,
  isAcceptedOutcome,
  observeHistoricalCases,
  replayEvalCase,
  SPOT_CHECK_CASE_ID
} from "../src/core/baseline/index.ts";
import { inventoryWorkflows } from "../src/core/inventory/workflows.ts";
import { resetWorkflowCache } from "../src/core/workflows/cache.ts";
import { bundledWorkflowsDir } from "../src/core/workflows/paths.ts";
import type { HarnessTask } from "../src/core/types.ts";

async function seedBundledWorkflows(targetRoot: string): Promise<void> {
  const runtimeDir = path.join(targetRoot, "workflows");
  await ensureDir(runtimeDir);
  for (const file of await readdir(bundledWorkflowsDir())) {
    if (!file.endsWith(".yml")) continue;
    await copyFile(path.join(bundledWorkflowsDir(), file), path.join(runtimeDir, file));
  }
}

function task(overrides: Partial<HarnessTask> & Pick<HarnessTask, "id">): HarnessTask {
  return {
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    agent: overrides.agent ?? "claude",
    source: overrides.source ?? "manual",
    links: [],
    targets: [],
    messages: overrides.messages ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("baseline quality floors", () => {
  it("keeps high-risk floors at least as strict as medium for default capability", () => {
    const floors = provisionalQualityFloors().filter((entry) => entry.capability === "default");
    const medium = floors.find((entry) => entry.risk === "medium")!.floor;
    const high = floors.find((entry) => entry.risk === "high")!.floor;
    expect(high.minAcceptedOutcomeRate).toBeGreaterThanOrEqual(medium.minAcceptedOutcomeRate);
    expect(high.minDeterministicPassRate).toBeGreaterThanOrEqual(medium.minDeterministicPassRate);
    expect(high.minFirstPassReviewRate).toBeGreaterThanOrEqual(medium.minFirstPassReviewRate);
  });
});

describe("baseline task metric aggregation", () => {
  it("counts completed tasks by resolution, not completedAt alone", () => {
    const tasks = [
      task({
        id: "completed",
        resolution: "completed",
        completedAt: "2026-01-02T00:00:00.000Z",
        startedAt: "2026-01-01T12:00:00.000Z",
        reviewState: "approved"
      }),
      task({
        id: "false-success",
        completedAt: "2026-01-02T00:00:00.000Z",
        resolution: "cancelled"
      })
    ];

    const metrics = aggregateTaskMetrics(tasks);
    expect(metrics.completed).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.withCompletedAtButNotSuccessful).toBe(1);
    expect(isAcceptedOutcome(tasks[1]!)).toBe(false);
  });

  it("classifies failed, cancelled, retried, and reviewed tasks", () => {
    const tasks = [
      task({
        id: "failed-checks",
        completedAt: "2026-01-03T00:00:00.000Z",
        lastCheckFailure: "lint failed",
        reviewState: "none"
      }),
      task({
        id: "cancelled",
        resolution: "cancelled",
        completedAt: "2026-01-03T00:00:00.000Z"
      }),
      task({
        id: "retried",
        resolution: "completed",
        completedAt: "2026-01-04T00:00:00.000Z",
        checkRound: 2,
        conflictRound: 1,
        resumeAttempts: 1,
        reviewState: "approved"
      }),
      task({
        id: "reviewed",
        resolution: "completed",
        completedAt: "2026-01-05T00:00:00.000Z",
        reviewRounds: 2,
        reviewState: "approved"
      })
    ];

    const metrics = aggregateTaskMetrics(tasks);
    expect(metrics.failed).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.retried).toBe(1);
    expect(metrics.reviewed).toBe(2);
    expect(metrics.averages.toolRetries).toBeCloseTo((2 + 1 + 1) / 4);
    expect(metrics.averages.reviewRounds).toBeCloseTo(0.5);
  });

  it("aggregates deterministic pass and first-pass review acceptance", () => {
    const tasks = [
      task({
        id: "clean-pass",
        resolution: "completed",
        completedAt: "2026-01-02T00:00:00.000Z",
        reviewRounds: 1,
        reviewState: "approved"
      }),
      task({
        id: "check-failure",
        resolution: "completed",
        completedAt: "2026-01-02T01:00:00.000Z",
        lastCheckFailure: "lint failed",
        reviewRounds: 1,
        reviewState: "approved"
      }),
      task({
        id: "review-rework",
        resolution: "completed",
        completedAt: "2026-01-02T02:00:00.000Z",
        reviewRounds: 2,
        reviewState: "approved"
      })
    ];

    const metrics = aggregateTaskMetrics(tasks);
    expect(metrics.deterministicPass).toBe(2);
    expect(metrics.firstPassReviewAccepted).toBe(2);
    expect(metrics.reviewed).toBe(3);
    expect(metrics.rates.deterministicPass).toBeCloseTo(2 / 3);
    expect(metrics.rates.firstPassReviewAccepted).toBeCloseTo(2 / 3);
  });

  it("records token and cost usage as unknown", () => {
    const metrics = aggregateTaskMetrics([
      task({ id: "one", resolution: "completed", completedAt: "2026-01-01T01:00:00.000Z" })
    ]);
    expect(metrics.usage.inputTokens).toBe("unknown");
    expect(metrics.usage.outputTokens).toBe("unknown");
    expect(metrics.usage.costUsd).toBe("unknown");
  });
});

describe("baseline corpus replay", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-baseline-"));
    await ensureHarnessRepository(root);
    await seedBundledWorkflows(root);
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("does not pass replay when a required check lacks replay fixtures", async () => {
    const corpus = await loadEvalCorpus();
    const target = corpus.cases.find((entry) => entry.case?.id === "small-api-guard");
    expect(target?.case).toBeDefined();
    const evalCase = structuredClone(target!.case!);
    delete evalCase.replay;

    const { runtimeDefinitions } = await inventoryWorkflows(root);
    const result = await replayEvalCase(evalCase, runtimeDefinitions);

    expect(result.passed).toBe(false);
    expect(result.structuralChecks.unsupported).toBeGreaterThan(0);
  });

  it("observes coverage-tier fixture metadata without treating synthetic placeholders as coverage", async () => {
    const corpus = await loadEvalCorpus();
    const coverage = observeHistoricalCases(corpus);
    expect(coverage.every((entry) => entry.taskClass !== "synthetic")).toBe(true);
    const smallApiGuard = coverage.find((entry) => entry.caseId === "small-api-guard");
    expect(smallApiGuard?.workflowId).toBe("code-feature");
    expect(smallApiGuard?.taskClass).toBe("small");
    expect(smallApiGuard?.risk).toBe("low");
    expect(smallApiGuard?.provenanceKind).toBe("synthetic");
  });
});

describe("baseline report", () => {
  let root: string;
  let outDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-baseline-report-"));
    outDir = path.join(process.cwd(), "tmp", `baseline-test-${Date.now()}`);
    await ensureHarnessRepository(root);
    await seedBundledWorkflows(root);
    resetWorkflowCache();

    await writeFile(
      path.join(root, "data", "state", "tasks.json"),
      `${JSON.stringify([
        task({
          id: "runtime-completed",
          title: "Guard empty JSON payloads in task API",
          resolution: "completed",
          completedAt: "2026-01-10T00:00:00.000Z",
          startedAt: "2026-01-09T20:00:00.000Z",
          reviewRounds: 1,
          reviewState: "approved",
          workflowRun: {
            workflowId: "code-feature",
            currentStepId: "handoff",
            completedSteps: ["handoff"],
            stepApprovals: {}
          }
        })
      ])}\n`,
      "utf8"
    );
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  });

  it("derives the same baseline id from equivalent inputs", () => {
    const inputs = {
      corpusVersion: "v1",
      caseIds: ["a", "b"],
      workflowHashes: { "code-feature": "abc" },
      modelIdentities: {
        defaultAgent: "claude",
        modelPools: [
          { id: "default", toolId: "claude", tier: "default", enabled: true, modelArgs: ["--model", "sonnet"] }
        ],
        stageOverrides: { author: "claude" }
      },
      metricsVersion: "1"
    };
    expect(computeBaselineId(inputs)).toBe(computeBaselineId(inputs));
  });

  it("changes baseline id when modelArgs fingerprint changes", () => {
    const base = {
      corpusVersion: "v1",
      caseIds: ["a"],
      workflowHashes: { "code-feature": "abc" },
      modelIdentities: {
        defaultAgent: "claude",
        modelPools: [
          { id: "default", toolId: "claude", tier: "default", enabled: true, modelArgs: ["--model", "sonnet"] }
        ],
        stageOverrides: {}
      },
      metricsVersion: "1"
    };
    const changed = {
      ...base,
      modelIdentities: {
        ...base.modelIdentities,
        modelPools: [
          { id: "default", toolId: "claude", tier: "default", enabled: true, modelArgs: ["--model", "opus"] }
        ]
      }
    };
    expect(computeBaselineId(base)).not.toBe(computeBaselineId(changed));
  });

});

describe("baseline spot-check matching", () => {
  // Pure matching logic over bundled fixtures + constructed runtime tasks.
  // No daemon replay: buildSpotCheck is exercised directly.
  let corpus: Awaited<ReturnType<typeof loadEvalCorpus>>;

  beforeAll(async () => {
    corpus = await loadEvalCorpus();
  });

  function spotCheckFixtures(): {
    observation: NonNullable<Parameters<typeof buildSpotCheck>[0]>;
    evalCase: NonNullable<Parameters<typeof buildSpotCheck>[1]>;
  } {
    const observation = observeHistoricalCases(corpus).find((entry) => entry.caseId === SPOT_CHECK_CASE_ID);
    const evalCase = corpus.cases.find((entry) => entry.case?.id === SPOT_CHECK_CASE_ID)?.case;
    if (!observation || !evalCase) throw new Error("spot-check case missing from bundled corpus");
    return { observation, evalCase };
  }

  it("matches a runtime task that shares workflow id and title", () => {
    const { observation, evalCase } = spotCheckFixtures();
    const spotCheck = buildSpotCheck(observation, evalCase, [
      task({
        id: "runtime-completed",
        title: evalCase.inputs.title,
        resolution: "completed",
        workflowRun: {
          workflowId: evalCase.workflowId,
          currentStepId: "handoff",
          completedSteps: ["handoff"],
          stepApprovals: {}
        }
      })
    ]);
    expect(spotCheck?.runtimeTaskFound).toBe(true);
    expect(spotCheck?.matchingRuntimeTaskId).toBe("runtime-completed");
    expect(spotCheck?.fieldsCompared.some((field) => field.field === "workflowId" && field.status === "match")).toBe(true);
  });

  it("reports an honest spot-check when no runtime task exists", () => {
    const { observation, evalCase } = spotCheckFixtures();
    const spotCheck = buildSpotCheck(observation, evalCase, []);
    expect(spotCheck?.runtimeTaskFound).toBe(false);
    expect(spotCheck?.fieldsCompared.some((field) => field.status === "no-runtime-task")).toBe(true);
  });

  it("does not match a runtime task that only shares the workflow id", () => {
    const { observation, evalCase } = spotCheckFixtures();
    const spotCheck = buildSpotCheck(observation, evalCase, [
      task({
        id: "other-feature",
        title: "Unrelated feature",
        resolution: "completed",
        workflowRun: {
          workflowId: evalCase.workflowId,
          currentStepId: "handoff",
          completedSteps: ["handoff"],
          stepApprovals: {}
        }
      })
    ]);
    expect(spotCheck?.runtimeTaskFound).toBe(false);
  });
});
