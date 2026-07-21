import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adoptAmbiguousLegacyOverride,
  bulkSetStageAgentOverrides,
  clearStageAgentOverride,
  loadStageAgentOverrides,
  resolveAgentForStep,
  resolveStepRouting,
  setStageAgentOverride,
  stageOverrideKey
} from "../src/core/agents/stage-agents.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { upsertExtension } from "../src/core/agents/extensions/store.ts";
import { resolveStepExtensions } from "../src/core/agents/extensions/launch.ts";
import { loadAgentConfig, saveAgentConfig } from "../src/core/agents/config/store.ts";
import {
  BUNDLED_WORKFLOW_IDS,
  isWorkflowAgentTool,
  loadWorkflow,
  resetWorkflowCache,
  resolveStepAgent
} from "../src/core/workflows/index.ts";
import type { ToolId } from "../src/core/types.ts";

describe("stage agents", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-stage-agents-"));
    await ensureHarnessRepository(root);
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("resolves concrete agents, role keywords, and gates from each workflow's own declarations", async () => {
    // Logic, not values: resolution must follow each workflow's declarations,
    // never a hardcoded agent name. Reassigning a step's agent (a supported
    // action that round-trips to YAML) must not break this test.
    const overrides = await loadStageAgentOverrides(root);
    const harnessDefault: ToolId = "grok";

    for (const id of BUNDLED_WORKFLOW_IDS) {
      const workflow = await loadWorkflow(root, id);

      for (const [stepId, step] of Object.entries(workflow.steps)) {
        const resolved = resolveStepAgent(workflow, overrides, stepId, harnessDefault);

        if (step.agent === "none") {
          // Gates / terminals route to no agent.
          expect(resolved).toBeNull();
        } else if (isWorkflowAgentTool(step.agent)) {
          // A concrete tool id resolves to itself.
          expect(resolved).toBe(step.agent);
        } else if (step.agent === "author") {
          // Role keywords resolve through the workflow's own defaults.
          expect(resolved).toBe(workflow.defaults.author);
        } else if (step.agent === "reviewer") {
          expect(resolved).toBe(workflow.defaults.reviewer);
        }
      }
    }
  });

  it("prefers overrides over the workflow's own agent default", async () => {
    // Pick an override that differs from whatever the workflow assigns, so the
    // test proves the override path rather than coincidentally matching the default.
    const baseline = await resolveAgentForStep(root, "code-feature", "implement");
    const overrideAgent: ToolId = baseline === "codex" ? "claude" : "codex";

    await setStageAgentOverride(root, "implement", overrideAgent);
    const agent = await resolveAgentForStep(root, "code-feature", "implement");
    expect(agent).toBe(overrideAgent);
    expect(agent).not.toBe(baseline);
  });

  it("prefers task overrides over global overrides and the workflow default", async () => {
    // Two distinct override agents so the assertion proves task-beats-global,
    // not a value that happens to equal the YAML default.
    await setStageAgentOverride(root, "implement", "codex");
    const agent = await resolveAgentForStep(root, "code-feature", "implement", { implement: "claude" });
    expect(agent).toBe("claude");
  });

  it("supports bulk overrides for multiple steps", async () => {
    await bulkSetStageAgentOverrides(root, ["implement", "plan"], "codex");
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides[stageOverrideKey("code-feature", "implement")]).toBe("codex");
    expect(config.overrides[stageOverrideKey("code-feature", "plan")]).toBe("codex");
    expect(await resolveAgentForStep(root, "code-feature", "implement")).toBe("codex");
    expect(await resolveAgentForStep(root, "code-feature", "plan")).toBe("codex");
  });

  it("clears overrides to fall back to the workflow's own agent default", async () => {
    // Capture the workflow's resolved default dynamically so the test asserts
    // "clearing restores the prior resolution", not a specific agent name.
    const baseline = await resolveAgentForStep(root, "code-feature", "review");
    const overrideAgent: ToolId = baseline === "claude" ? "codex" : "claude";

    await setStageAgentOverride(root, "review", overrideAgent);
    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(overrideAgent);

    await clearStageAgentOverride(root, "review", "code-feature");
    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(baseline);
  });

  it("rejects overrides on steps without agents", async () => {
    await expect(setStageAgentOverride(root, "handoff", "claude")).rejects.toThrow(
      'Step "handoff" does not use an agent.'
    );
  });

  it("validates overrides against workflow-specific step ids", async () => {
    await expect(setStageAgentOverride(root, "implement", "grok", "bugfix")).rejects.toThrow(
      'Unknown workflow step: implement'
    );
    await setStageAgentOverride(root, "fix", "grok", "bugfix");
    expect(await resolveAgentForStep(root, "bugfix", "fix")).toBe("grok");
  });

  it("rejects clearing overrides for unknown workflow steps", async () => {
    await expect(clearStageAgentOverride(root, "implement", "bugfix")).rejects.toThrow(
      'Unknown workflow step: implement'
    );
  });

  it("persists workflow-specific stage agent overrides on disk", async () => {
    await setStageAgentOverride(root, "fix", "grok", "bugfix");
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides[stageOverrideKey("bugfix", "fix")]).toBe("grok");
    expect(await resolveAgentForStep(root, "bugfix", "fix")).toBe("grok");
  });

  it("keeps distinct overrides for the same step id across workflows", async () => {
    const codeFeatureBaseline = await resolveAgentForStep(root, "code-feature", "review");
    const bugfixBaseline = await resolveAgentForStep(root, "bugfix", "review");
    const codeFeatureOverride: ToolId = codeFeatureBaseline === "claude" ? "codex" : "claude";
    const bugfixOverride: ToolId = bugfixBaseline === "claude" ? "codex" : "claude";

    await setStageAgentOverride(root, "review", codeFeatureOverride, "code-feature");
    await setStageAgentOverride(root, "review", bugfixOverride, "bugfix");

    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(codeFeatureOverride);
    expect(await resolveAgentForStep(root, "bugfix", "review")).toBe(bugfixOverride);

    await clearStageAgentOverride(root, "review", "code-feature");
    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(codeFeatureBaseline);
    expect(await resolveAgentForStep(root, "bugfix", "review")).toBe(bugfixOverride);
  });

  it("rejects unknown workflow ids", async () => {
    await expect(setStageAgentOverride(root, "review", "claude", "no-such-workflow")).rejects.toThrow(
      "Unknown workflow: no-such-workflow"
    );
  });

  it("migrates unambiguous legacy overrides to scoped keys", async () => {
    await writeJsonFile(path.join(root, "data", "state", "stage-agents.json"), {
      overrides: { fix: "grok" }
    });
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides).toEqual({ [stageOverrideKey("bugfix", "fix")]: "grok" });
    expect(config.ambiguousLegacy).toBeUndefined();
    expect(await resolveAgentForStep(root, "bugfix", "fix")).toBe("grok");
  });

  it("preserves orphan legacy overrides in ambiguousLegacy", async () => {
    await writeJsonFile(path.join(root, "data", "state", "stage-agents.json"), {
      overrides: { deleted_step: "grok" }
    });
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides).toEqual({});
    expect(config.ambiguousLegacy).toEqual({ deleted_step: "grok" });
  });

  it("surfaces ambiguous legacy overrides without applying them", async () => {
    const codeFeatureBaseline = await resolveAgentForStep(root, "code-feature", "review");
    const bugfixBaseline = await resolveAgentForStep(root, "bugfix", "review");
    const legacyAgent: ToolId = codeFeatureBaseline === "claude" ? "codex" : "claude";
    await writeJsonFile(path.join(root, "data", "state", "stage-agents.json"), {
      overrides: { review: legacyAgent }
    });
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides).toEqual({});
    expect(config.ambiguousLegacy).toEqual({ review: legacyAgent });
    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(codeFeatureBaseline);
    expect(await resolveAgentForStep(root, "bugfix", "review")).toBe(bugfixBaseline);
  });

  it("adopts an ambiguous legacy override for a chosen workflow", async () => {
    const bugfixBaseline = await resolveAgentForStep(root, "bugfix", "review");
    const legacyAgent: ToolId = bugfixBaseline === "claude" ? "codex" : "claude";
    await writeJsonFile(path.join(root, "data", "state", "stage-agents.json"), {
      overrides: { review: legacyAgent }
    });
    await loadStageAgentOverrides(root);

    await adoptAmbiguousLegacyOverride(root, "review", "code-feature");
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides).toEqual({ [stageOverrideKey("code-feature", "review")]: legacyAgent });
    expect(config.ambiguousLegacy).toBeUndefined();
    expect(await resolveAgentForStep(root, "code-feature", "review")).toBe(legacyAgent);
    expect(await resolveAgentForStep(root, "bugfix", "review")).toBe(bugfixBaseline);
  });

  it("refuses to adopt a legacy override for a disabled agent", async () => {
    const bundle = await loadAgentConfig(root);
    await saveAgentConfig(root, {
      ...bundle,
      tools: bundle.tools.map((tool) => tool.id === "claude" ? { ...tool, enabled: false } : tool)
    });
    await writeJsonFile(path.join(root, "data", "state", "stage-agents.json"), {
      overrides: { review: "claude" }
    });
    await loadStageAgentOverrides(root);

    await expect(adoptAmbiguousLegacyOverride(root, "review", "code-feature")).rejects.toThrow(
      'Agent "claude" is disabled.'
    );
    expect((await loadStageAgentOverrides(root)).ambiguousLegacy).toEqual({ review: "claude" });
  });

  it("resolveStepExtensions honors workflow step extension facet", async () => {
    await upsertExtension(root, {
      id: "claude:plugin:seo@market",
      toolId: "claude",
      kind: "plugin",
      displayName: "SEO",
      source: "seo@market",
      detectedFrom: "manual",
      defaultEnabled: false
    });

    const resolved = await resolveStepExtensions({
      root,
      toolId: "claude",
      step: {
        id: "implement",
        kind: "agent_turn",
        agent: "author",
        approval: "none",
        next: "review",
        extensions: ["claude:plugin:seo@market"]
      }
    });
    expect(resolved.enabledIds).toEqual(["claude:plugin:seo@market"]);
  });

  it("resolveStepRouting returns extension arrays on routing decisions", async () => {
    const routing = await resolveStepRouting(root, "code-feature", "implement");
    expect(routing).not.toBeNull();
    expect(Array.isArray(routing?.extensions)).toBe(true);
    expect(Array.isArray(routing?.extensionEntries)).toBe(true);
  });
});
