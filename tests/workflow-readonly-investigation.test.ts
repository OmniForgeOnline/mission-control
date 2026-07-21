import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { mergeInvestigationPlanIntoDescription } from "../src/core/prompts/investigation.ts";
import { processNextApprovedTask } from "../src/daemon/processor.ts";
import { createTask, getTask } from "../src/core/tasks/tasks.ts";
import { buildLaunchArgs } from "../src/runners/adapter.ts";
import { AcpAgentRunner } from "../src/runners/acp/runner.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import { createServer } from "../src/server/app.ts";
import { installFakeAcpServer, kiroPool, kiroTool } from "./helpers/fake-acp-server.ts";
import {
  loadWorkflow,
  stepIsReadOnlyInvestigation,
  stepRunnerMode
} from "../src/core/workflows/index.ts";
import { buildStepContractSection } from "../src/core/workflows/step-contract.ts";
import { buildInitialPrompt } from "../src/daemon/prompts.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import type { HarnessTask } from "../src/core/types.ts";
import type { WorkflowStep } from "../src/core/workflows/types.ts";
import type { AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";

const readOnlyInvestigate: WorkflowStep = {
  id: "investigate",
  kind: "agent_turn",
  agent: "codex",
  skill: "technical-investigation",
  modifiesRepo: false,
  approval: "none",
  next: "plan_gate"
};

function stubTask(): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "task-1",
    title: "Crash on empty payload",
    description: "Connector webhook handler throws when body is empty.",
    agent: "codex",
    source: "manual",
    links: [],
    targets: [{ path: "/repo/src/connectors", kind: "directory", raw: "@/repo/src/connectors" }],
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("read-only investigation steps", () => {
  it("detects explicit modifiesRepo false on agent_turn only", () => {
    expect(stepIsReadOnlyInvestigation(readOnlyInvestigate)).toBe(true);
    expect(
      stepIsReadOnlyInvestigation({
        kind: "agent_turn"
      })
    ).toBe(false);
    expect(
      stepIsReadOnlyInvestigation({
        kind: "conversation"
      })
    ).toBe(false);
  });

  it("maps read-only investigation to plan runner mode", () => {
    expect(stepRunnerMode(readOnlyInvestigate)).toBe("plan");
    expect(
      stepRunnerMode({
        id: "fix",
        kind: "agent_turn",
        agent: "claude",
        skill: "pr-driven-execution",
        approval: "required"
      })
    ).toBe("execute");
    expect(
      stepRunnerMode({
        id: "plan",
        kind: "conversation",
        agent: "codex",
        approval: "none"
      })
    ).toBe("plan");
  });

  it("builds a read-only step contract and prompt", () => {
    const section = buildStepContractSection("bugfix", readOnlyInvestigate);
    expect(section).toContain("read-only investigation");
    expect(section).toContain("`read`");
    expect(section).toContain("`diagnose`");
    expect(section).not.toContain("Repo mutation: yes");

    const prompt = buildInitialPrompt(
      "/tmp/root",
      stubTask(),
      "- technical-investigation",
      { cwd: "/repo", isRepo: false, created: false, repoPath: "/repo" },
      "bugfix",
      readOnlyInvestigate
    );
    expect(prompt).toContain("read-only investigation");
    expect(prompt).toContain("Do NOT edit files");
    expect(prompt).toContain("<proposed_plan>");
    expect(prompt).toContain("non-mutating diagnostics");
  });

  it("uses read-only runner permissions for claude and codex in plan mode", () => {
    const bundle = builtinAgentConfigBundle();
    const claude = bundle.tools.find((tool) => tool.id === "claude")!;
    const claudePool = bundle.pools.find((pool) => pool.toolId === "claude")!;
    const claudeArgs = buildLaunchArgs(claude, claudePool, {
      mode: "plan",
      prompt: "inspect",
      cwd: "/repo"
    }).args;
    expect(claudeArgs).toContain("--permission-mode");
    expect(claudeArgs[claudeArgs.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(claudeArgs).not.toContain("--dangerously-skip-permissions");

    const codex = bundle.tools.find((tool) => tool.id === "codex")!;
    const codexPool = bundle.pools.find((pool) => pool.id === "codex-default")!;
    const codexArgs = buildLaunchArgs(codex, codexPool, {
      mode: "plan",
      prompt: "inspect",
      cwd: "/repo"
    }).args;
    expect(codexArgs).toContain("-s");
    expect(codexArgs[codexArgs.indexOf("-s") + 1]).toBe("read-only");
  });

  it("persists investigation artifacts into the task description plan section", () => {
    const merged = mergeInvestigationPlanIntoDescription("Bug report", "# Root cause\nNull deref.");
    expect(merged).toContain("## Plan");
    expect(merged).toContain("Null deref.");
    expect(mergeInvestigationPlanIntoDescription("Bug report\n\n## Plan\n\nExisting", "New")).toBe(
      "Bug report\n\n## Plan\n\nNew"
    );
    // The plan body carries `## ` subheaders (Reproduction, Root Cause, ...), so
    // the merge consumes from `## Plan` to end-of-description. Content before the
    // plan heading is preserved; post-plan sections are not, since plan content
    // is now indistinguishable from later `## ` sections.
    expect(
      mergeInvestigationPlanIntoDescription(
        "Bug report\n\n## Plan\n\nOld plan\n\n## Reproduction\nsteps",
        "New plan\n\n## Reproduction\nnew steps"
      )
    ).toBe("Bug report\n\n## Plan\n\nNew plan\n\n## Reproduction\nnew steps");
  });

  it("denies writes through the plan-mode ACP permission path used by investigation steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-readonly-acp-"));
    try {
      const script = await installFakeAcpServer(root);
      const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
      const mode = stepRunnerMode(readOnlyInvestigate);
      expect(mode).toBe("plan");
      const result = await runner.runTurn({
        task: { targets: [] } as unknown as HarnessTask,
        prompt: "inspect repo",
        cwd: root,
        turnNumber: 1,
        mode
      });
      expect(result.exitCode).toBe(0);
      expect(result.reply).toContain("fs-rejected");
      expect(result.reply).toContain("denied");
      expect(result.reply).not.toContain("fs-ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workflow definitions for read-only investigation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-readonly-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("configures bugfix investigate as read-only agent_turn", async () => {
    const bugfix = await loadWorkflow(root, "bugfix");
    const investigate = bugfix.steps["investigate"]!;
    expect(investigate.kind).toBe("agent_turn");
    expect(investigate.modifiesRepo).toBe(false);
    expect(stepIsReadOnlyInvestigation(investigate)).toBe(true);
    expect(investigate.skill).toBe("technical-investigation");
  });

  it("matches the small-null-payload bugfix fixture shape", async () => {
    const bugfix = await loadWorkflow(root, "bugfix");
    expect(bugfix.steps["investigate"]?.next).toBe("plan_gate");
    expect(bugfix.steps["plan_gate"]?.next).toBe("fix");
    expect(bugfix.steps["fix"]?.skill).toBe("pr-driven-execution");
    expect(stepRunnerMode(bugfix.steps["investigate"]!)).toBe("plan");
    expect(stepRunnerMode(bugfix.steps["fix"]!)).toBe("execute");
  });
});

class ModeRecordingRunner extends DeterministicAgentRunner {
  modes: Array<AgentTurnRequest["mode"]> = [];

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.modes.push(request.mode);
    return super.runTurn(request);
  }
}

async function waitForTask(
  root: string,
  taskId: string,
  predicate: (task: NonNullable<Awaited<ReturnType<typeof getTask>>>) => boolean,
  timeoutMs = 5000
): Promise<Awaited<ReturnType<typeof getTask>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(root, taskId);
    if (task && predicate(task)) return task;
    if (Date.now() >= deadline) return task;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("bugfix investigation daemon replay", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-readonly-daemon-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs investigate in plan mode and advances in one turn with an artifact", async () => {
    const runner = new ModeRecordingRunner("claude");
    runner.setReplies([
      [
        "Reproduced with empty webhook body; handler throws before validation.",
        "",
        "<proposed_plan>",
        "# Root cause",
        "Null payload reaches JSON.parse in webhook handler.",
        "",
        "## Reproduction",
        "POST /webhook with empty body returns 500.",
        "",
        "## Root Cause",
        "Null payload reaches JSON.parse in webhook handler.",
        "",
        "## Evidence",
        "Stack trace shows JSON.parse throwing on empty input.",
        "",
        "## Affected Surface",
        "src/connectors/webhook.ts",
        "",
        "## Test Strategy",
        "Add regression test for empty body returning 400.",
        "",
        "## Confidence",
        "high",
        "</proposed_plan>"
      ].join("\n")
    ]);

    const task = await createTask(root, {
      title: "Fix crash on empty webhook payload",
      description:
        "Connector webhook handler throws when body is empty; return 400 and log a structured skip reason.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    const current = await getTask(root, task.id);

    expect(runner.modes[0]).toBe("plan");
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current?.description).toContain("## Plan");
    expect(current?.description).toContain("Null payload reaches JSON.parse");
    expect(current && (await taskLegacyStatus(root, current))).toBe("queued");
  });

  it("does not advance investigation on final-answer heuristics without a plan artifact", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies(["Investigation complete. The fix is done and shipped."]);

    const task = await createTask(root, {
      title: "Fix crash on empty webhook payload",
      description: "Connector webhook handler throws when body is empty.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    const current = await getTask(root, task.id);

    expect(current?.workflowRun?.currentStepId).toBe("investigate");
    expect(current?.description).not.toContain("## Plan");
  });

  it("replaces a stale investigation plan after refinement rewind", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      [
        "<proposed_plan>",
        "# Root cause",
        "Null payload reaches JSON.parse in webhook handler.",
        "",
        "## Reproduction",
        "POST /webhook with empty body returns 500.",
        "",
        "## Root Cause",
        "Null payload reaches JSON.parse in webhook handler.",
        "",
        "## Evidence",
        "Stack trace shows JSON.parse throwing on empty input.",
        "",
        "## Affected Surface",
        "src/connectors/webhook.ts",
        "",
        "## Test Strategy",
        "Regression test for empty body.",
        "",
        "## Confidence",
        "high",
        "</proposed_plan>"
      ].join("\n"),
      [
        "<proposed_plan>",
        "# Root cause",
        "Validation layer rejects empty bodies before JSON.parse.",
        "",
        "## Reproduction",
        "POST /webhook with empty body returns 400.",
        "",
        "## Root Cause",
        "Validation layer rejects empty bodies before JSON.parse.",
        "",
        "## Evidence",
        "Validation log shows empty bodies rejected.",
        "",
        "## Affected Surface",
        "src/connectors/webhook.ts",
        "",
        "## Test Strategy",
        "Regression test for empty body.",
        "",
        "## Confidence",
        "high",
        "</proposed_plan>"
      ].join("\n")
    ]);

    const task = await createTask(root, {
      title: "Fix crash on empty webhook payload",
      description: "Connector webhook handler throws when body is empty.",
      workflowId: "bugfix",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    let current = await getTask(root, task.id);
    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current?.description).toContain("JSON.parse in webhook handler");

    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Check the validation layer first." })
      .expect(201);

    current = await waitForTask(
      root,
      task.id,
      (t) =>
        (t.turnCount ?? 0) >= 2 &&
        (t.description?.includes("Validation layer rejects empty bodies") ?? false)
    );

    expect(current?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(current?.description).toContain("Validation layer rejects empty bodies");
    expect(current?.description).not.toContain("JSON.parse in webhook handler");
  });
});
