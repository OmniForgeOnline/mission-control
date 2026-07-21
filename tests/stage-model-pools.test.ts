import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearStageModelPoolOverride,
  loadStageModelPoolOverrides,
  setStageModelPoolOverride
} from "../src/core/agents/stage-model-pools.ts";
import { loadAgentConfig, saveAgentConfig } from "../src/core/agents/config/store.ts";
import { setStageAgentOverride, stageOverrideKey, resolveStepRouting } from "../src/core/agents/stage-agents.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";
import {
  clearTaskStageModelPoolOverride,
  createTask,
  setTaskStageModelPoolOverride
} from "../src/core/tasks/tasks.ts";
import { resetWorkflowCache } from "../src/core/workflows/index.ts";

describe("workflow stage model pools", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-stage-model-pools-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("persists workflow-scoped model pool overrides on disk", async () => {
    await setStageModelPoolOverride(root, "implement", "claude-default", "code-feature");
    const config = await loadStageModelPoolOverrides(root);
    expect(config.overrides[stageOverrideKey("code-feature", "implement")]).toBe("claude-default");
  });

  it("keeps distinct model pool overrides for the same step id across workflows", async () => {
    await setStageModelPoolOverride(root, "review", "codex-default", "code-feature");
    await setStageModelPoolOverride(root, "review", "claude-default", "write-document");

    const routingCodeFeature = await resolveStepRouting(root, "code-feature", "review");
    const routingWriteDocument = await resolveStepRouting(root, "write-document", "review");

    expect(routingCodeFeature?.modelPoolId).toBe("codex-default");
    expect(routingWriteDocument?.modelPoolId).toBe("claude-default");

    await clearStageModelPoolOverride(root, "review", "code-feature");
    const config = await loadStageModelPoolOverrides(root);
    expect(config.overrides[stageOverrideKey("code-feature", "review")]).toBeUndefined();
    expect(config.overrides[stageOverrideKey("write-document", "review")]).toBe("claude-default");
    expect((await resolveStepRouting(root, "write-document", "review"))?.modelPoolId).toBe(
      "claude-default"
    );
  });

  it("prefers task overrides over workflow defaults", async () => {
    await setStageModelPoolOverride(root, "implement", "claude-default", "code-feature");

    const withTaskOverride = await resolveStepRouting(
      root,
      "code-feature",
      "implement",
      { implement: "claude" },
      { implement: "claude-default" }
    );
    expect(withTaskOverride?.modelPoolId).toBe("claude-default");

    const workflowOnly = await resolveStepRouting(root, "code-feature", "implement", {
      implement: "codex"
    });
    expect(workflowOnly?.modelPoolId).toBe("codex-default");
  });

  it("rejects unknown workflow, step, and pool ids", async () => {
    await expect(
      setStageModelPoolOverride(root, "implement", "no-such-pool", "code-feature")
    ).rejects.toThrow(/not registered/i);
    await expect(
      setStageModelPoolOverride(root, "implement", "codex-default", "no-such-workflow")
    ).rejects.toThrow(/Unknown workflow/i);
    await expect(
      setStageModelPoolOverride(root, "implement", "codex-default", "bugfix")
    ).rejects.toThrow(/Unknown workflow step/i);
  });

  it("sets and clears workflow model pool overrides over HTTP", async () => {
    const app = createServer({ root, testMode: true });

    const setResponse = await request(app)
      .post("/api/settings/stage-model-pools/implement")
      .send({ poolId: "claude-default", workflowId: "code-feature" })
      .expect(200);
    expect(setResponse.body.overrides[stageOverrideKey("code-feature", "implement")]).toBe(
      "claude-default"
    );

    const state = await request(app).get("/api/state").expect(200);
    expect(state.body.stageModelPoolOverrides[stageOverrideKey("code-feature", "implement")]).toBe(
      "claude-default"
    );

    await request(app)
      .delete("/api/settings/stage-model-pools/implement?workflowId=code-feature")
      .expect(200);

    const clearedState = await request(app).get("/api/state").expect(200);
    expect(
      clearedState.body.stageModelPoolOverrides?.[stageOverrideKey("code-feature", "implement")]
    ).toBeUndefined();
  });

  it("clears task overrides without removing workflow defaults", async () => {
    await setStageModelPoolOverride(root, "implement", "claude-default", "code-feature");
    const task = await createTask(root, {
      title: "Clear task pool",
      description: "Workflow default remains.",
      source: "manual",
      links: []
    });
    await setTaskStageModelPoolOverride(root, task.id, "implement", "claude-default");
    await clearTaskStageModelPoolOverride(root, task.id, "implement");

    const routing = await resolveStepRouting(
      root,
      "code-feature",
      "implement",
      { implement: "codex" }
    );
    expect(routing?.modelPoolId).toBe("codex-default");
  });

  it("does not fall back when a workflow pool pin is ineligible", async () => {
    await setStageAgentOverride(root, "implement", "codex", "code-feature");
    await setStageModelPoolOverride(root, "implement", "codex-default", "code-feature");
    const bundle = await loadAgentConfig(root);
    await saveAgentConfig(root, {
      ...bundle,
      pools: bundle.pools.map((pool) =>
        pool.id === "codex-default" ? { ...pool, enabled: false } : pool
      )
    });

    const routing = await resolveStepRouting(root, "code-feature", "implement");
    expect(routing).toBeNull();
  });
});
