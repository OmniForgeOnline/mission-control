import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { upsertModelPool } from "../src/core/agents/config/store.ts";
import { saveUsageSnapshots } from "../src/core/agents/config/usage-store.ts";
import type { ModelPoolConfig } from "../src/core/agents/config/types.ts";
import { assessPinWarnings } from "../src/core/runs/routing-decision.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { createTask, setTaskStageAgentOverride, setTaskStageModelPoolOverride } from "../src/core/tasks/tasks.ts";
import { createServer } from "../src/server/app.ts";

function codexPool(overrides: Partial<ModelPoolConfig>): ModelPoolConfig {
  return {
    id: "codex-default",
    toolId: "codex",
    displayName: "Codex (default)",
    modelArgs: [],
    modelEnv: {},
    capabilities: ["author", "reviewer", "code", "plan", "review"],
    tier: "paid",
    usage: { kind: "usage-only", softThresholdPercent: 80 },
    usageSource: "none",
    enabled: true,
    builtin: false,
    ...overrides
  };
}

describe("routing decision helpers", () => {
  it("warns on unverified identity pins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-routing-warn-"));
    await ensureHarnessRepository(root);
    try {
      await upsertModelPool(
        root,
        codexPool({
          id: "codex-unverified",
          identity: { provider: "openai", configuredModel: "gpt-5", verificationState: "unverified" }
        })
      );
      const bundle = (await import("../src/core/agents/config/store.ts")).loadAgentConfig;
      const config = await bundle(root);
      const pool = config.pools.find((entry) => entry.id === "codex-unverified");
      expect(pool).toBeTruthy();
      const warnings = assessPinWarnings(
        config,
        { snapshots: [], refreshedAt: new Date().toISOString() },
        "codex",
        pool!
      );
      expect(warnings.some((warning) => warning.code === "unverified-identity")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("routing transparency API", () => {
  let root: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-routing-api-"));
    await ensureHarnessRepository(root);
    app = createServer({ root, testMode: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns live step routing decisions", async () => {
    const task = await createTask(root, {
      title: "Routing",
      description: "Step routing preview",
      source: "manual",
      links: []
    });
    const response = await request(app).get(`/api/tasks/${task.id}/steps/implement/routing`);
    expect(response.status).toBe(200);
    expect(response.body.decision.harness).toBeTruthy();
    expect(response.body.decision.modelPoolId).toBeTruthy();
    expect(response.body.decision.reason).toBeTruthy();
  });

  it("returns recorded run routing decisions", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Task",
      agent: "claude",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifacts: [],
      modelPoolId: "claude-default",
      routingDecision: {
        harness: "claude",
        modelPoolId: "claude-default",
        capability: "author",
        source: "preferred",
        reason: "routed author → claude/claude-default",
        provider: "anthropic",
        configuredModel: "claude-sonnet-5",
        quotaState: "available",
        rejected: [],
        recordedAt: new Date().toISOString()
      }
    });

    const apiResponse = await request(app).get(`/api/runs/${run.id}/routing`);
    expect(apiResponse.status).toBe(200);
    expect(apiResponse.body.decision.harness).toBe("claude");
    expect(apiResponse.body.decision.modelPoolId).toBe("claude-default");
  });

  it("requires confirmation for warned model pins", async () => {
    const task = await createTask(root, {
      title: "Pin warn",
      description: "Warn before pin",
      source: "manual",
      links: []
    });
    await setTaskStageAgentOverride(root, task.id, "implement", "codex");

    const preview = await request(app)
      .post(`/api/tasks/${task.id}/stage-model-pools/implement/preview`)
      .send({ poolId: "codex-default" });
    expect(preview.status).toBe(200);
    expect(preview.body.warnings.length).toBeGreaterThan(0);

    const blocked = await request(app)
      .post(`/api/tasks/${task.id}/stage-model-pools/implement`)
      .send({ poolId: "codex-default" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.warnings).toBeTruthy();

    const confirmed = await request(app)
      .post(`/api/tasks/${task.id}/stage-model-pools/implement`)
      .send({ poolId: "codex-default", acknowledgeWarnings: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.stageModelPoolOverrides).toEqual({ implement: "codex-default" });
  });

  it("clears scoped pins back to policy routing", async () => {
    const task = await createTask(root, {
      title: "Reset pin",
      description: "Reset routing",
      source: "manual",
      links: []
    });
    await setTaskStageModelPoolOverride(root, task.id, "implement", "codex-default");
    const cleared = await request(app).delete(`/api/tasks/${task.id}/stage-model-pools/implement`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.stageModelPoolOverrides ?? {}).toEqual({});
  });

  it("reports optimizer fallback when the preferred provider is exhausted", async () => {
    const task = await createTask(root, {
      title: "Fallback routing",
      description: "Exhaust preferred tool",
      source: "manual",
      links: []
    });
    await setTaskStageAgentOverride(root, task.id, "implement", "codex");
    await saveUsageSnapshots(root, {
      snapshots: [
        {
          toolId: "codex",
          used: 100,
          usedPercent: 100,
          fetchedAt: new Date().toISOString(),
          source: "harness"
        }
      ],
      refreshedAt: new Date().toISOString()
    });

    const response = await request(app).get(`/api/tasks/${task.id}/steps/implement/routing`);
    expect(response.status).toBe(200);
    expect(response.body.decision.source).toBe("optimizer-fallback");
    expect(response.body.decision.harness).not.toBe("codex");
    expect(
      response.body.decision.rejected.some(
        (entry: { reason: string }) => entry.reason === "quota-exhausted"
      )
    ).toBe(true);
  });

  it("surfaces exhausted quota state on recorded run routing", async () => {
    const run = await createRun(root, {
      taskId: "task-exhausted",
      taskTitle: "Exhausted",
      agent: "codex",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifacts: [],
      modelPoolId: "codex-default",
      routingDecision: {
        harness: "codex",
        modelPoolId: "codex-default",
        capability: "author",
        source: "preferred",
        reason: "pinned author → codex/codex-default",
        provider: "openai",
        configuredModel: "(default)",
        quotaState: "exhausted",
        rejected: [],
        recordedAt: new Date().toISOString()
      }
    });

    const response = await request(app).get(`/api/runs/${run.id}/routing`);
    expect(response.status).toBe(200);
    expect(response.body.decision.quotaState).toBe("exhausted");
  });
});
