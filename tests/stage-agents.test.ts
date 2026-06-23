import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bulkSetStageAgentOverrides,
  clearStageAgentOverride,
  loadStageAgentOverrides,
  resolveAgentForStep,
  setStageAgentOverride
} from "../src/core/agents/stage-agents.ts";
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
    expect(config.overrides['implement']).toBe("codex");
    expect(config.overrides['plan']).toBe("codex");
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

    await clearStageAgentOverride(root, "review");
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

  it("persists workflow-specific stage agent overrides on disk", async () => {
    await setStageAgentOverride(root, "fix", "grok", "bugfix");
    const config = await loadStageAgentOverrides(root);
    expect(config.overrides['fix']).toBe("grok");
    expect(await resolveAgentForStep(root, "bugfix", "fix")).toBe("grok");
  });
});