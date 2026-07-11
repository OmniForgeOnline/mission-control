import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { isRegisteredModelPool, resolveStepRouting } from "../src/core/agents/stage-agents.ts";
import type { ModelPoolConfig } from "../src/core/agents/config/types.ts";
import { upsertModelPool } from "../src/core/agents/config/store.ts";
import { createServer } from "../src/server/app.ts";
import {
  clearTaskStageModelPoolOverride,
  createTask,
  setTaskStageModelPoolOverride
} from "../src/core/tasks/tasks.ts";
import { resetWorkflowCache } from "../src/core/workflows/index.ts";

function codexPool(overrides: Partial<ModelPoolConfig>): ModelPoolConfig {
  return {
    id: "codex-default",
    toolId: "codex",
    displayName: "Codex (default)",
    modelArgs: [],
    modelEnv: {},
    capabilities: ["author", "reviewer", "code", "plan", "review"],
    qualityWeight: 80,
    tier: "paid",
    usage: { kind: "usage-only", softThresholdPercent: 80 },
    usageSource: "none",
    enabled: true,
    builtin: false,
    ...overrides
  };
}

describe("task stage model pools", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-task-stage-models-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("persists per-task stage model pool overrides", async () => {
    const task = await createTask(root, {
      title: "Override model",
      description: "Task-specific stage model pool.",
      source: "manual",
      links: []
    });
    const updated = await setTaskStageModelPoolOverride(root, task.id, "implement", "codex-default");
    expect(updated.stageModelPoolOverrides).toEqual({ implement: "codex-default" });
  });

  it("rejects an unknown model pool id", async () => {
    const task = await createTask(root, {
      title: "Bad model",
      description: "Unknown pool.",
      source: "manual",
      links: []
    });
    await expect(
      setTaskStageModelPoolOverride(root, task.id, "implement", "no-such-pool")
    ).rejects.toThrow(/not registered/);
  });

  it("clears per-task stage model pool overrides", async () => {
    const task = await createTask(root, {
      title: "Clear model",
      description: "Reset to optimizer default.",
      source: "manual",
      links: []
    });
    await setTaskStageModelPoolOverride(root, task.id, "implement", "codex-default");
    const cleared = await clearTaskStageModelPoolOverride(root, task.id, "implement");
    expect(cleared.stageModelPoolOverrides ?? {}).toEqual({});
  });

  it("isRegisteredModelPool is true for a configured pool and false otherwise", async () => {
    expect(await isRegisteredModelPool(root, "codex-default")).toBe(true);
    expect(await isRegisteredModelPool(root, "no-such-pool")).toBe(false);
  });

  it("resolveStepRouting honors a model pool override that matches the resolved tool", async () => {
    // Add a second, deliberately weaker codex pool so the optimizer would pick
    // codex-default; the override forcing codex-extra proves the branch ran.
    await upsertModelPool(root, codexPool({ id: "codex-extra", qualityWeight: 1 }));

    const routing = await resolveStepRouting(
      root,
      "code-feature",
      "implement",
      { implement: "codex" },
      { implement: "codex-extra" }
    );

    expect(routing?.modelPoolId).toBe("codex-extra");
    expect(routing?.toolId).toBe("codex");
  });

  it("resolveStepRouting ignores an override whose pool belongs to a different tool", async () => {
    // Agent overridden to codex; model override points at a claude pool. The
    // override must be ignored (tool mismatch) and the optimizer picks codex.
    const routing = await resolveStepRouting(
      root,
      "code-feature",
      "implement",
      { implement: "codex" },
      { implement: "claude-default" }
    );

    expect(routing?.toolId).toBe("codex");
    expect(routing?.modelPoolId).toBe("codex-default");
  });

  it("resolveStepRouting ignores an override whose pool is disabled", async () => {
    await upsertModelPool(root, codexPool({ id: "codex-disabled", enabled: false }));

    const routing = await resolveStepRouting(
      root,
      "code-feature",
      "implement",
      { implement: "codex" },
      { implement: "codex-disabled" }
    );

    expect(routing?.toolId).toBe("codex");
    expect(routing?.modelPoolId).toBe("codex-default");
  });

  it("resolveStepRouting defaults to the tool's no-arg pool (does not force a model)", async () => {
    // No model pinned: claude must resolve to its no-arg default pool, not the
    // highest-quality named model. Forcing a named model by default would break
    // a tool pointed at a custom provider (e.g. z.ai).
    const routing = await resolveStepRouting(root, "code-feature", "implement", {
      implement: "claude"
    });

    expect(routing?.toolId).toBe("claude");
    expect(routing?.modelPoolId).toBe("claude-default");
  });

  it("sets and clears the model pool override over HTTP", async () => {
    const task = await createTask(root, {
      title: "HTTP model",
      description: "Route a model pin over HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const setResponse = await request(app)
      .post(`/api/tasks/${task.id}/stage-model-pools/implement`)
      .send({ poolId: "codex-default" });
    expect(setResponse.status).toBe(200);
    expect(setResponse.body.stageModelPoolOverrides).toEqual({ implement: "codex-default" });

    const clearResponse = await request(app)
      .delete(`/api/tasks/${task.id}/stage-model-pools/implement`);
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.stageModelPoolOverrides).toBeUndefined();
  });

  it("rejects an unregistered model pool over HTTP", async () => {
    const task = await createTask(root, {
      title: "HTTP bad model",
      description: "Reject unknown pool over HTTP.",
      source: "manual",
      links: []
    });
    const app = createServer({ root });

    const rejected = await request(app)
      .post(`/api/tasks/${task.id}/stage-model-pools/implement`)
      .send({ poolId: "no-such-pool" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/not registered/i);
  });
});
