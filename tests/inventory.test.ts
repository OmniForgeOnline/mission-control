import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { loadAgentConfig } from "../src/core/agents/config/store.ts";
import { ensureDir } from "../src/core/infra/fs.ts";
import {
  collectRuntimeInventory,
  stableInventorySnapshot,
  writeInventorySnapshot
} from "../src/core/inventory/index.ts";
import { redactValue } from "../src/core/inventory/redact.ts";
import { resetWorkflowCache } from "../src/core/workflows/cache.ts";
import { bundledWorkflowsDir } from "../src/core/workflows/paths.ts";

async function seedBundledWorkflows(targetRoot: string): Promise<void> {
  const runtimeDir = path.join(targetRoot, "workflows");
  await ensureDir(runtimeDir);
  for (const file of await readdir(bundledWorkflowsDir())) {
    if (!file.endsWith(".yml")) continue;
    await copyFile(path.join(bundledWorkflowsDir(), file), path.join(runtimeDir, file));
  }
}

describe("runtime inventory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-inventory-"));
    await ensureHarnessRepository(root);
    await seedBundledWorkflows(root);
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("classifies bundled workflows as unchanged on a fresh harness", async () => {
    const inventory = await collectRuntimeInventory(root);
    const codeFeature = inventory.workflows.find((entry) => entry.id === "code-feature");
    expect(codeFeature?.status).toBe("unchanged");
    const bugfix = inventory.workflows.find((entry) => entry.id === "bugfix");
    expect(bugfix?.status).toBe("unchanged");
  });

  it("includes model pool identity and verification in inventory summaries", async () => {
    await loadAgentConfig(root);
    const inventory = await collectRuntimeInventory(root);
    const pool = inventory.modelPools.find((entry) => entry.id === "claude-sonnet-5");
    expect(pool).toMatchObject({
      toolId: "claude",
      provider: "anthropic",
      configuredModel: "claude-sonnet-5",
      verificationState: "verified"
    });
  });

  it("detects runtime-customized code-feature and bugfix definitions", async () => {
    const customized = await readFile(path.join(bundledWorkflowsDir(), "code-feature.yml"), "utf8");
    await writeFile(
      path.join(root, "workflows", "code-feature.yml"),
      customized.replace("name: Code Feature", "name: Custom Code Feature"),
      "utf8"
    );
    const bugfix = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    await writeFile(
      path.join(root, "workflows", "bugfix.yml"),
      bugfix.replace("name: Bugfix", "name: Custom Bugfix"),
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.workflows.find((entry) => entry.id === "code-feature")?.status).toBe(
      "runtime-customized"
    );
    expect(inventory.workflows.find((entry) => entry.id === "bugfix")?.status).toBe("runtime-customized");
  });

  it("reports bundled-only workflows missing from runtime", async () => {
    await rm(path.join(root, "workflows", "seo-investigation.yml"));

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.workflows.find((entry) => entry.id === "seo-investigation")?.status).toBe("bundled-only");
  });

  it("reports runtime-only workflows", async () => {
    await writeFile(
      path.join(root, "workflows", "custom-flow.yml"),
      `id: custom-flow
name: Custom Flow
initial: start
defaults:
  agents:
    author: claude
    reviewer: codex
steps:
  start:
    kind: terminal
    agent: none
    approval: none
`,
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.workflows.find((entry) => entry.id === "custom-flow")?.status).toBe("runtime-only");
  });

  it("loads runtime-only workflows stored as .yaml", async () => {
    await writeFile(
      path.join(root, "workflows", "yaml-only-flow.yaml"),
      `id: yaml-only-flow
name: YAML Only Flow
initial: start
defaults:
  agents:
    author: claude
    reviewer: codex
steps:
  start:
    kind: terminal
    agent: none
    approval: none
`,
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    const workflow = inventory.workflows.find((entry) => entry.id === "yaml-only-flow");
    expect(workflow?.status).toBe("runtime-only");
    expect(workflow?.runtime).toBe(true);
  });

  it("surfaces invalid skill references from workflow YAML", async () => {
    await writeFile(
      path.join(root, "workflows", "bad-skill-ref.yml"),
      `id: bad-skill-ref
name: Bad Skill Ref
initial: start
steps:
  start:
    kind: agent_turn
    agent: author
    approval: none
    skill: definitely-not-packaged
    next: done
  done:
    kind: terminal
    agent: none
    approval: none
`,
      "utf8"
    );
    resetWorkflowCache();

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.drift.missingSkillPackaging).toContain("definitely-not-packaged");
    const missing = inventory.skills.find((entry) => entry.id === "definitely-not-packaged");
    expect(missing?.status).toBe("invalid-reference");
  });

  it("packages harness-quality so workflow references resolve after seeding", async () => {
    const inventory = await collectRuntimeInventory(root);
    const harnessQuality = inventory.skills.find((entry) => entry.id === "harness-quality");
    expect(harnessQuality?.seeded).toBe(true);
    expect(harnessQuality?.runtime).toBe(true);
    expect(harnessQuality?.status).toBe("unchanged");
  });

  it("surfaces contradictory pr-driven-execution bodies across packaged and runtime sources", async () => {
    const inventory = await collectRuntimeInventory(root);
    const contradiction = inventory.drift.contradictorySkillBodies.find(
      (entry) => entry.skill === "pr-driven-execution"
    );
    expect(contradiction).toBeDefined();
    expect(contradiction?.sources.length).toBeGreaterThanOrEqual(2);
    expect(new Set(contradiction?.sources.map((source) => source.bodyHash)).size).toBeGreaterThan(1);
  });

  it("reports unknown agent ids, model ids, and tool/model ownership mismatches", async () => {
    await writeFile(
      path.join(root, "workflows", "bad-models.yml"),
      `id: bad-models
name: Bad Models
initial: step
defaults:
  agents:
    author: phantom-agent
    reviewer: codex
steps:
  step:
    kind: agent_turn
    agent: phantom-agent
    approval: none
`,
      "utf8"
    );
    await loadAgentConfig(root);
    const configPath = path.join(root, "data", "state", "agent-config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.pools.push({
      id: "orphan.pool",
      toolId: "missing-tool",
      capabilities: ["author"],
      tier: "free",
      enabled: true
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(root, "data", "state", "usage-snapshots.json"),
      `${JSON.stringify(
        {
          refreshedAt: "2026-01-01T00:00:00.000Z",
          snapshots: [{ toolId: "codex", modelPoolId: "phantom-model-pool", usedPercent: 10 }]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.drift.unknownAgentIds).toContain("phantom-agent");
    expect(inventory.drift.unknownModelIds).toContain("phantom-model-pool");
    expect(inventory.drift.toolModelOwnershipMismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          poolId: "orphan.pool",
          toolId: "missing-tool",
          reason: "missing-tool",
          modelArgs: []
        })
      ])
    );
  });

  it("does not infer model ownership from adapter name namespaces", async () => {
    await loadAgentConfig(root);
    const configPath = path.join(root, "data", "state", "agent-config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.pools.push({
      id: "bad-claude-model",
      toolId: "claude",
      capabilities: ["author"],
      tier: "free",
      enabled: true,
      modelArgs: ["--model", "phantom-claude-model"]
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.drift.toolModelOwnershipMismatches).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ poolId: "bad-claude-model", reason: "unknown-model" })])
    );
  });

  it("redacts secret flag pairs and modelEnv values from structured inventory data", () => {
    const redacted = redactValue({
      modelArgs: ["--api-key", "hunter2"],
      modelEnv: { OPENAI_API_KEY: "hunter2" },
      headers: ["-H", "Authorization: Bearer sk-testtoken1234567890"]
    });
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).not.toContain("sk-testtoken1234567890");
    expect(redacted.modelArgs).toEqual(["--api-key", "[REDACTED]"]);
    expect(redacted.modelEnv.OPENAI_API_KEY).toBe("[REDACTED]");
  });

  it("records workflow usage counts from tasks without mutating state", async () => {
    const tasksPath = path.join(root, "data", "state", "tasks.json");
    await writeFile(
      tasksPath,
      `${JSON.stringify([
        {
          id: "t1",
          title: "One",
          description: "",
          agent: "claude",
          source: "manual",
          links: [],
          targets: [],
          messages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          turnCount: 3,
          reviewRounds: 1,
          resolution: "completed",
          workflowRun: { workflowId: "code-feature", currentStepId: "handoff", completedSteps: [], stepApprovals: {} }
        },
        {
          id: "t2",
          title: "Two",
          description: "",
          agent: "claude",
          source: "manual",
          links: [],
          targets: [],
          messages: [],
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          turnCount: 2,
          workflowRun: { workflowId: "bugfix", currentStepId: "implement", completedSteps: [], stepApprovals: {} }
        }
      ])}\n`,
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    expect(inventory.workflowUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowId: "code-feature",
          taskCount: 1,
          completedCount: 1,
          totalTurns: 3,
          totalReviewRounds: 1
        }),
        expect.objectContaining({
          workflowId: "bugfix",
          taskCount: 1,
          completedCount: 0,
          totalTurns: 2,
          totalReviewRounds: 0
        })
      ])
    );
  });

  it("produces the same semantic snapshot on consecutive runs", async () => {
    const first = stableInventorySnapshot(await collectRuntimeInventory(root));
    const second = stableInventorySnapshot(await collectRuntimeInventory(root));
    expect(second).toEqual(first);
  });

  it("redacts credentials from collected settings output", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    await writeFile(
      path.join(root, "data", "state", "settings.json"),
      `${JSON.stringify({ projectsRoot: `/tmp/${secret}/projects` }, null, 2)}\n`,
      "utf8"
    );

    const inventory = await collectRuntimeInventory(root);
    const serialized = JSON.stringify(inventory);
    expect(inventory.settings.projectsRoot).not.toContain(secret);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/accessToken/i);
  });

  it("writes snapshots under tmp via helper", async () => {
    const outPath = path.join(root, "tmp", "runtime-inventory.json");
    const inventory = await collectRuntimeInventory(root);
    await writeInventorySnapshot(inventory, outPath);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.schemaVersion).toBe(1);
    expect(written.workflows.length).toBeGreaterThan(0);
  });
});
