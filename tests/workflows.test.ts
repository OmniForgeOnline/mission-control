import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUNDLED_WORKFLOW_IDS,
  ensureWorkflowFiles,
  findImplementationStepId,
  findUpstreamStepId,
  isWorkflowAgentTool,
  listWorkflowSummaries,
  loadAllWorkflows,
  loadWorkflow,
  resetWorkflowCache,
  resolveStepAgent,
  stepModifiesRepo,
  stepUsesRepoWorkspace,
  toWorkflowMetadata,
  validateWorkflow,
  workflowFilePath
} from "../src/core/workflows/index.ts";
import { advanceWorkflowStep, createWorkflowRun } from "../src/core/workflows/run.ts";
import { buildResolvedStageAgents } from "../src/core/agents/stage-agents.ts";
import type { ToolId } from "../src/core/types.ts";
import { parse as parseYaml } from "yaml";

describe("workflow types", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-workflow-"));
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("loads all bundled workflow YAML files", async () => {
    const workflows = await loadAllWorkflows(root);
    for (const id of BUNDLED_WORKFLOW_IDS) {
      expect(workflows.has(id)).toBe(true);
    }

    const codeFeature = workflows.get("code-feature")!;
    expect(codeFeature.initial).toBe("plan");
    expect(codeFeature.steps['plan']?.kind).toBe("conversation");
    expect(codeFeature.steps['plan']?.skill).toBe("product-discovery");
    expect(codeFeature.steps['implement']?.approval).toBe("required");
    expect(codeFeature.steps['review']?.branch?.['approved']).toBe("handoff");
    expect(codeFeature.steps['review']?.branch?.['changes_requested']).toBe("implement");
    expect(codeFeature.steps['implement']?.next).toBe("create_merge_request");
    expect(codeFeature.steps['create_merge_request']?.kind).toBe("create_merge_request");
    expect(codeFeature.steps['create_merge_request']?.next).toBe("resolve_conflicts");
    expect(codeFeature.steps['resolve_conflicts']?.kind).toBe("resolve_conflicts");
    expect(codeFeature.steps['resolve_conflicts']?.next).toBe("review");
  });

  it("initializes workflow runs from workflow definitions", async () => {
    const workflow = await loadWorkflow(root, "bugfix");
    const run = createWorkflowRun(workflow);
    expect(run.workflowId).toBe("bugfix");
    expect(run.currentStepId).toBe("investigate");
    expect(run.completedSteps).toEqual([]);
  });

  it("rejects unknown next step references", () => {
    expect(() =>
      validateWorkflow({
        id: "broken",
        name: "Broken",
        initial: "start",
        steps: {
          start: { kind: "agent_turn", agent: "author", approval: "none", next: "missing" }
        }
      })
    ).toThrow('unknown next step "missing"');
  });

  it("rejects invalid effort values", () => {
    expect(() =>
      validateWorkflow({
        id: "x",
        name: "X",
        initial: "start",
        defaults: { effort: "turbo" },
        steps: {
          start: { kind: "agent_turn", agent: "author", approval: "none", next: "done" },
          done: { kind: "terminal", agent: "none", approval: "none" }
        }
      })
    ).toThrow('invalid effort "turbo"');
  });

  it("accepts arbitrary tool ids as step agents (validated at routing time)", () => {
    const workflow = validateWorkflow({
      id: "x",
      name: "X",
      initial: "start",
      steps: {
        start: { kind: "agent_turn", agent: "kilo-cli", approval: "none", next: "done" },
        done: { kind: "terminal", agent: "none", approval: "none" }
      }
    });
    expect(workflow.steps["start"]!.agent).toBe("kilo-cli");
  });

  it("rejects an empty agent value", () => {
    expect(() =>
      validateWorkflow({
        id: "x",
        name: "X",
        initial: "start",
        steps: {
          start: { kind: "agent_turn", agent: "", approval: "none", next: "done" },
          done: { kind: "terminal", agent: "none", approval: "none" }
        }
      })
    ).toThrow('invalid agent');
  });

  it("validates richer workflows with longer step chains and branch points", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(Object.keys(workflow.steps)).toHaveLength(7);
    expect(workflow.steps['implement']?.next).toBe("create_merge_request");
    expect(workflow.steps['review']?.branch?.['approved']).toBe("handoff");

    const blog = await loadWorkflow(root, "blog-post");
    expect(blog.steps['editorial_review']?.branch?.['changes_requested']).toBe("draft");
    expect(blog.steps['seo_review']?.next).toBe("editorial_review");

    const debt = await loadWorkflow(root, "technical-debt");
    expect(debt.steps['review']?.branch?.['approved']).toBe("capture_followups");
    expect(debt.steps['capture_followups']?.next).toBe("handoff");
  });

  it("lists workflow summaries for the UI", async () => {
    const summaries = await listWorkflowSummaries(root);
    expect(summaries.map((s) => s.id)).toEqual(expect.arrayContaining([...BUNDLED_WORKFLOW_IDS]));
    expect(summaries).toHaveLength(BUNDLED_WORKFLOW_IDS.length);

    const codeFeature = summaries.find((s) => s.id === "code-feature");
    expect(codeFeature?.stepIds).toEqual(
      expect.arrayContaining([
        "plan",
        "plan_gate",
        "implement",
        "create_merge_request",
        "resolve_conflicts",
        "review",
        "handoff"
      ])
    );
  });

  it("exposes workflow metadata with resolved stage agents", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const metadata = await toWorkflowMetadata(root, workflow);

    // The wrapper mirrors the workflow's own declarations rather than hardcoded
    // agent names — reassigning an agent must not break this test.
    expect(metadata.defaults).toEqual(workflow.defaults);
    expect(metadata.steps['implement']?.agent).toBe(workflow.steps['implement']?.agent);

    // It threads a resolved stage-agent entry through for every step.
    expect(metadata.stageAgents.map((entry) => entry.stage).sort()).toEqual(
      Object.keys(workflow.steps).sort()
    );

    // Source attribution follows the data, not a literal: a step naming a
    // concrete tool is attributed to the step; a role keyword to the default.
    const plan = metadata.stageAgents.find((entry) => entry.stage === "plan")!;
    const review = metadata.stageAgents.find((entry) => entry.stage === "review")!;
    expect(plan.source).toBe(
      isWorkflowAgentTool(workflow.steps['plan']!.agent) ? "step" : "workflow-default"
    );
    expect(review.source).toBe(
      isWorkflowAgentTool(workflow.steps['review']!.agent) ? "step" : "workflow-default"
    );
    if (workflow.steps['review']!.agent === "reviewer") {
      expect(review.agent).toBe(workflow.defaults.reviewer);
    }
  });

  it("resolves every step to a routed agent with correct source attribution", async () => {
    // Logic, not values: for each bundled workflow, the resolution must obey the
    // precedence rules computed from that workflow's own declarations. No agent
    // name is hardcoded, so reassigning a step's agent can never break this.
    for (const id of BUNDLED_WORKFLOW_IDS) {
      const workflow = await loadWorkflow(root, id);
      const defaultAgent: ToolId = "codex";
      const resolved = buildResolvedStageAgents(workflow, { overrides: {} }, defaultAgent);

      // Every step is represented exactly once — none left unrouted.
      expect(resolved.map((entry) => entry.stage).sort()).toEqual(
        Object.keys(workflow.steps).sort()
      );

      for (const entry of resolved) {
        const declared = workflow.steps[entry.stage]!.agent;
        if (declared === "none") {
          // Gates / terminals route to no agent.
          expect(entry.agent).toBeNull();
          expect(entry.source).toBe("none");
          continue;
        }
        // An agent-running step always resolves to a concrete agent.
        expect(entry.agent).toBeTruthy();
        if (isWorkflowAgentTool(declared)) {
          expect(entry.agent).toBe(declared);
          expect(entry.source).toBe("step");
        } else if (declared === "author") {
          expect(entry.agent).toBe(workflow.defaults.author);
          expect(entry.source).toBe("workflow-default");
        } else if (declared === "reviewer") {
          expect(entry.agent).toBe(workflow.defaults.reviewer);
          expect(entry.source).toBe("workflow-default");
        }
      }
    }
  });

  it("an override outranks the step/default agent regardless of who is assigned", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const stage = "implement";
    // Pick an override that differs from whatever the workflow currently assigns,
    // computed dynamically so the test never depends on a specific agent name.
    const assigned = resolveStepAgent(workflow, { overrides: {} }, stage, "codex");
    const overrideAgent: ToolId = assigned === "grok" ? "opencode" : "grok";

    const resolved = buildResolvedStageAgents(
      workflow,
      { overrides: { [stage]: overrideAgent } },
      "codex"
    );
    const entry = resolved.find((e) => e.stage === stage)!;
    expect(entry.agent).toBe(overrideAgent);
    expect(entry.source).toBe("override");
    expect(entry.override).toBe(overrideAgent);
  });

  it("ships no standalone checks stage in any bundled workflow", async () => {
    // Mechanical checks are no longer a workflow stage: the post-implementation
    // turn runs the project-aware planner inline. No bundled workflow may carry a
    // `checks` step, and docs-update now routes its draft straight to review.
    for (const id of BUNDLED_WORKFLOW_IDS) {
      const workflow = await loadWorkflow(root, id);
      const hasChecksStage = Object.values(workflow.steps).some((s) => (s.kind as string) === "checks");
      expect(hasChecksStage).toBe(false);
    }

    const writeDoc = await loadWorkflow(root, "write-document");
    expect(writeDoc.steps['draft']?.next).toBe("review");

    const docsUpdate = await loadWorkflow(root, "docs-update");
    expect(docsUpdate.steps['draft_docs']?.next).toBe("review");
    expect(docsUpdate.steps['validate_links']).toBeUndefined();
  });

  it("fails startup validation for malformed workflow files", async () => {
    await ensureWorkflowFiles(root);
    const file = workflowFilePath(root, "code-feature");
    await writeFile(file, "id: broken\nname: Broken\ninitial: nowhere\nsteps: {}\n", "utf8");
    resetWorkflowCache();
    await expect(loadWorkflow(root, "code-feature")).rejects.toThrow('initial step "nowhere"');
  });

  it("finds implementation steps across repo workflows", async () => {
    expect(findImplementationStepId(await loadWorkflow(root, "code-feature"))).toBe("implement");
    expect(findImplementationStepId(await loadWorkflow(root, "bugfix"))).toBe("fix");
    expect(findImplementationStepId(await loadWorkflow(root, "frontend-ui-change"))).toBe("implement_ui");
    expect(findImplementationStepId(await loadWorkflow(root, "infrastructure-change"))).toBe("apply_change");
    expect(findImplementationStepId(await loadWorkflow(root, "technical-debt"))).toBe("implement");
  });

  it("exposes git pipeline metadata for all repo workflows", async () => {
    const { listWorkflowSummaries } = await import("../src/core/workflows/metadata.ts");
    const summaries = await listWorkflowSummaries(root);
    const expected: Record<string, string> = {
      "code-feature": "implement",
      bugfix: "fix",
      "technical-debt": "implement",
      "infrastructure-change": "apply_change",
      "frontend-ui-change": "implement_ui"
    };

    for (const [workflowId, remediationStepId] of Object.entries(expected)) {
      const summary = summaries.find((entry) => entry.id === workflowId);
      expect(summary?.gitPipeline?.remediationStepId).toBe(remediationStepId);
      expect(summary?.gitPipeline?.postPushStepIds).toContain("handoff");
      expect(summary?.gitPipeline?.postPushStepIds).toContain("review");
    }
  });

  it("bugfix workflow mirrors code-feature planning gate before implementation", async () => {
    const bugfix = await loadWorkflow(root, "bugfix");
    expect(bugfix.steps['investigate']?.next).toBe("plan_gate");
    expect(bugfix.steps['plan_gate']?.agent).toBe("none");
    expect(bugfix.steps['plan_gate']?.next).toBe("fix");
    expect(bugfix.steps['review']?.branch?.['changes_requested']).toBe("fix");
  });

  it("marks repo-changing implement steps and keeps planning off worktrees", async () => {
    const codeFeature = await loadWorkflow(root, "code-feature");
    expect(stepModifiesRepo(codeFeature.steps['implement']!)).toBe(true);
    expect(stepModifiesRepo(codeFeature.steps['plan']!)).toBe(false);
    expect(stepUsesRepoWorkspace(codeFeature.steps['plan']!, {})).toBe(false);
    expect(stepUsesRepoWorkspace(codeFeature.steps['review']!, { repoPath: "/repo" })).toBe(true);

    const frontend = await loadWorkflow(root, "frontend-ui-change");
    expect(frontend.steps['implement_ui']?.next).toBe("create_merge_request");
  });

  it("copies bundled workflows into the harness root", async () => {
    await ensureWorkflowFiles(root);
    const text = await readFile(workflowFilePath(root, "write-document"), "utf8");
    const doc = parseYaml(text) as Record<string, unknown>;
    expect(doc['id']).toBe("write-document");
  });

  it("branchless advance on review stays on review without completing", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "review",
      completedSteps: ["plan", "plan_gate", "implement", "create_merge_request"]
    };

    const { run: next, done } = advanceWorkflowStep(workflow, run);
    expect(done).toBe(false);
    expect(next.currentStepId).toBe("review");
    expect(next.completedSteps).not.toContain("review");
  });

  it("approved branch on review advances to handoff and records review completion", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "review",
      completedSteps: ["plan", "plan_gate", "implement", "create_merge_request"]
    };

    const { run: next, done } = advanceWorkflowStep(workflow, run, "approved");
    expect(done).toBe(false);
    expect(next.currentStepId).toBe("handoff");
    expect(next.completedSteps).toContain("review");
    expect(next.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(1);
  });

  it("terminal handoff step completes with done true", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = {
      ...createWorkflowRun(workflow),
      currentStepId: "handoff",
      completedSteps: ["plan", "plan_gate", "implement", "create_merge_request", "review"]
    };

    const { run: next, done } = advanceWorkflowStep(workflow, run);
    expect(done).toBe(true);
    expect(next.currentStepId).toBe("handoff");
    expect(next.completedSteps).toContain("handoff");
  });

  it("finds the upstream author step for review routing", async () => {
    const docsUpdate = await loadWorkflow(root, "docs-update");
    expect(findUpstreamStepId(docsUpdate, "review")).toBe("draft_docs");

    const codeFeature = await loadWorkflow(root, "code-feature");
    expect(findUpstreamStepId(codeFeature, "resolve_conflicts")).toBe("create_merge_request");
  });
});
