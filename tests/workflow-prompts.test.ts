import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildConversationFollowupPrompt,
  buildConversationPrompt,
  buildFollowupPrompt,
  extractFinalPlan,
  hasOperatorReplySinceLastAgentTurn,
  normalizeReplyForPlanExtraction,
  splitPlanningMessage
} from "../src/core/workflows/prompts.ts";
import { buildStableAgentPrefix, buildInitialPrompt } from "../src/daemon/prompts.ts";
import { buildStepContractSection } from "../src/core/workflows/step-contract.ts";
import type { WorkflowStep } from "../src/core/workflows/index.ts";
import type { HarnessAttachment, HarnessTask } from "../src/core/types.ts";

function stubTask(messages: HarnessTask["messages"]): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "task-1",
    title: "Task",
    description: "desc",
    agent: "codex",
    source: "manual",
    links: [],
    targets: [],
    messages,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("workflow prompts", () => {
  it("extractFinalPlan strips markdown fences around proposed_plan", () => {
    const reply = [
      "FINAL_PLAN:",
      "",
      "```markdown",
      "<proposed_plan>",
      "# Plan",
      "Step one",
      "</proposed_plan>",
      "```"
    ].join("\n");

    expect(extractFinalPlan(reply)).toBe("# Plan\nStep one");
  });

  it("extractFinalPlan preserves inner code fences", () => {
    const reply = [
      "<proposed_plan>",
      "# Plan",
      "```yaml",
      "create_merge_request:",
      "  kind: create_merge_request",
      "```",
      "</proposed_plan>"
    ].join("\n");

    expect(extractFinalPlan(reply)).toBe(
      "# Plan\n```yaml\ncreate_merge_request:\n  kind: create_merge_request\n```"
    );
  });

  it("hasOperatorReplySinceLastAgentTurn is false without an operator message", () => {
    const task = stubTask([
      { id: "1", author: "agent", body: "Question?", createdAt: "2026-01-01T00:00:00.000Z" }
    ]);
    expect(hasOperatorReplySinceLastAgentTurn(task)).toBe(false);
  });

  it("hasOperatorReplySinceLastAgentTurn is true after the operator replies", () => {
    const task = stubTask([
      { id: "1", author: "agent", body: "Question?", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Use src/core.", createdAt: "2026-01-01T00:01:00.000Z" }
    ]);
    expect(hasOperatorReplySinceLastAgentTurn(task)).toBe(true);
  });

  it("buildConversationFollowupPrompt frames operator input as plan refinement", () => {
    const step: WorkflowStep = {
      id: "technical_plan",
      kind: "conversation",
      agent: "codex",
      approval: "none"
    };
    const task = stubTask([
      { id: "1", author: "agent", body: "Here is the plan.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Add more tests for fs.ts.", createdAt: "2026-01-01T00:01:00.000Z" }
    ]);
    task.description = "Task\n\n## Plan\n\n# Plan\nStep one";

    const prompt = buildConversationFollowupPrompt(task, step, "/tmp/workspace", "/tmp/root", "## Kernel");
    expect(prompt).toContain("technical_plan");
    expect(prompt).toContain("Add more tests for fs.ts.");
    expect(prompt).toContain("refine the plan");
    expect(prompt).toContain("Do NOT edit any files");
  });

  it("buildConversationPrompt surfaces operator attachment refs the agent can read", () => {
    const step: WorkflowStep = {
      id: "technical_plan",
      kind: "conversation",
      agent: "codex",
      approval: "none"
    };
    const attachment: HarnessAttachment = {
      id: "11111111-1111-4111-8111-111111111111",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      size: 2048,
      source: "workflow",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "operator", body: "Plan from this.", createdAt: "2026-01-01T00:00:00.000Z", attachments: [attachment] }
    ]);

    const prompt = buildConversationPrompt(task, step, "/tmp/workspace", "/tmp/root", "## Kernel");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/11111111-1111-4111-8111-111111111111");
    expect(prompt).toContain('filename "spec.pdf"');
    expect(prompt).toContain("2048 bytes");
    expect(prompt).toContain("application/pdf");
  });

  it("buildConversationPrompt surfaces task-level attachment refs on the first conversation turn", () => {
    const step: WorkflowStep = {
      id: "technical_plan",
      kind: "conversation",
      agent: "codex",
      approval: "none"
    };
    const attachment: HarnessAttachment = {
      id: "44444444-4444-4444-8444-444444444444",
      filename: "intake-brief.pdf",
      mimeType: "application/pdf",
      size: 2048,
      source: "intake",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "operator", body: "Plan from this.", createdAt: "2026-01-01T00:00:00.000Z" }
    ]);
    task.attachments = [attachment];

    const prompt = buildConversationPrompt(task, step, "/tmp/workspace", "/tmp/root", "## Kernel");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/44444444-4444-4444-8444-444444444444");
    expect(prompt).toContain('filename "intake-brief.pdf"');
    expect(prompt).toContain("2048 bytes");
    expect(prompt).toContain("application/pdf");
  });

  it("buildConversationFollowupPrompt surfaces attachment refs on the refining reply", () => {
    const step: WorkflowStep = {
      id: "technical_plan",
      kind: "conversation",
      agent: "codex",
      approval: "none"
    };
    const attachment: HarnessAttachment = {
      id: "22222222-2222-4222-8222-222222222222",
      filename: "notes.md",
      mimeType: "text/markdown",
      size: 42,
      source: "workflow",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "agent", body: "Draft plan.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Refine using this.", createdAt: "2026-01-01T00:01:00.000Z", attachments: [attachment] }
    ]);

    const prompt = buildConversationFollowupPrompt(task, step, "/tmp/workspace", "/tmp/root", "## Kernel");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/22222222-2222-4222-8222-222222222222");
    expect(prompt).toContain('filename "notes.md"');
  });

  it("buildConversationFollowupPrompt surfaces task-level attachment refs when refining the plan", () => {
    const step: WorkflowStep = {
      id: "technical_plan",
      kind: "conversation",
      agent: "codex",
      approval: "none"
    };
    const attachment: HarnessAttachment = {
      id: "55555555-5555-4555-8555-555555555555",
      filename: "clickup-spec.md",
      mimeType: "text/markdown",
      size: 42,
      source: "clickup",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "agent", body: "Draft plan.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Refine using this.", createdAt: "2026-01-01T00:01:00.000Z" }
    ]);
    task.attachments = [attachment];

    const prompt = buildConversationFollowupPrompt(task, step, "/tmp/workspace", "/tmp/root", "## Kernel");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/55555555-5555-4555-8555-555555555555");
    expect(prompt).toContain('filename "clickup-spec.md"');
  });

  it("buildStepContractSection identifies the configured skill loaded in the prompt", () => {
    const section = buildStepContractSection("code-feature", {
      id: "implement",
      kind: "agent_turn",
      agent: "claude",
      skill: "pr-driven-execution",
      approval: "required",
      modifiesRepo: true
    });
    expect(section).toContain("Workflow: `code-feature`");
    expect(section).toContain("Step: `implement`");
    expect(section).toContain("is loaded below");
    expect(section).toContain("`pr-driven-execution`");
    expect(section).not.toContain("if it helps");
    expect(section).not.toContain("# Mission Control");
  });

  it("buildStepContractSection omits read_skill when no skill is configured", () => {
    const section = buildStepContractSection("bugfix", {
      id: "investigate",
      kind: "agent_turn",
      agent: "claude",
      approval: "none"
    });
    expect(section).toContain("Workflow: `bugfix`");
    expect(section).not.toContain("read_skill");
  });

  it("buildConversationPrompt identifies the configured skill loaded in the header", () => {
    const step: WorkflowStep = {
      id: "plan",
      kind: "conversation",
      agent: "codex",
      skill: "product-discovery",
      approval: "none"
    };
    const stablePrefix = buildStableAgentPrefix("/tmp/root", stubTask([]), "- skills", "code-feature", step);
    const prompt = buildConversationPrompt(stubTask([]), step, "/tmp/workspace", "/tmp/root", stablePrefix);
    expect(prompt).toContain("loaded in the prompt header");
    expect(prompt).not.toContain("if it helps");
    expect(prompt).toContain("Workflow step contract");
  });

  it("initial and follow-up agent prompts share the same workflow and step contract", () => {
    const step: WorkflowStep = {
      id: "implement",
      kind: "agent_turn",
      agent: "claude",
      skill: "pr-driven-execution",
      approval: "required",
      modifiesRepo: true
    };
    const task = stubTask([
      { id: "1", author: "agent", body: "Working.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Also cover edge cases.", createdAt: "2026-01-01T00:01:00.000Z" }
    ]);
    const skills = "- pr-driven-execution: execute (skills/pr-driven-execution/SKILL.md)";
    const stablePrefix = buildStableAgentPrefix("/tmp/root", task, skills, "code-feature", step);
    const initial = buildInitialPrompt("/tmp/root", task, skills, { cwd: "/tmp/ws", isRepo: true, created: true, repoPath: "/repo", branch: "feat/x" }, "code-feature", step);
    const followup = buildFollowupPrompt(task, "/tmp/root", stablePrefix);
    expect(initial).toContain("Workflow: `code-feature`");
    expect(initial).toContain("Step: `implement`");
    expect(followup).toContain("Workflow: `code-feature`");
    expect(followup).toContain("Step: `implement`");
    expect(followup).toContain("Also cover edge cases.");
    expect(initial).not.toMatch(/description:\s*.+\n[\s\S]*---[\s\S]*# /);
  });

  it("buildFollowupPrompt surfaces attachment refs on the latest operator message", () => {
    const attachment: HarnessAttachment = {
      id: "33333333-3333-4333-8333-333333333333",
      filename: "error.log",
      mimeType: "text/plain",
      size: 7,
      source: "workflow",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "operator", body: "Look at this log.", createdAt: "2026-01-01T00:00:00.000Z", attachments: [attachment] }
    ]);

    const prompt = buildFollowupPrompt(task, "/tmp/root", "## Stable prefix");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/33333333-3333-4333-8333-333333333333");
    expect(prompt).toContain('filename "error.log"');
  });

  it("buildFollowupPrompt surfaces task-level attachment refs on a follow-up turn", () => {
    const attachment: HarnessAttachment = {
      id: "66666666-6666-4666-8666-666666666666",
      filename: "clickup-brief.pdf",
      mimeType: "application/pdf",
      size: 4096,
      source: "clickup",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "agent", body: "Draft reply.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", author: "operator", body: "Update using the brief.", createdAt: "2026-01-01T00:01:00.000Z" }
    ]);
    task.attachments = [attachment];

    const prompt = buildFollowupPrompt(task, "/tmp/root", "## Stable prefix");
    expect(prompt).toContain("/tmp/root/data/state/attachments/files/66666666-6666-4666-8666-666666666666");
    expect(prompt).toContain('filename "clickup-brief.pdf"');
    expect(prompt).toContain("4096 bytes");
  });

  it("buildFollowupPrompt references a shared attachment once across task and message", () => {
    const shared: HarnessAttachment = {
      id: "77777777-7777-4777-8777-777777777777",
      filename: "shared.log",
      mimeType: "text/plain",
      size: 7,
      source: "workflow",
      createdAt: "2026-06-19T00:00:00.000Z"
    };
    const task = stubTask([
      { id: "1", author: "operator", body: "Use this.", createdAt: "2026-01-01T00:00:00.000Z", attachments: [shared] }
    ]);
    task.attachments = [shared];

    const prompt = buildFollowupPrompt(task, "/tmp/root", "## Stable prefix");
    const occurrences = prompt.split("77777777-7777-4777-8777-777777777777").length - 1;
    expect(occurrences).toBe(1);
  });

  it("splitPlanningMessage separates narrative from proposed_plan", () => {
    const body = [
      "### Planning turn 1",
      "",
      "Loading skills and inspecting the ui domain.",
      "",
      "<proposed_plan>",
      "# UI quality gate plan",
      "Add tests/ui-scopes.test.ts.",
      "</proposed_plan>"
    ].join("\n");

    const parts = splitPlanningMessage(body);
    expect(parts?.turnLabel).toBe("### Planning turn 1");
    expect(parts?.preamble).toContain("Loading skills");
    expect(parts?.plan).toContain("UI quality gate plan");
    expect(parts?.plan).not.toContain("Loading skills");
  });

  it("splitPlanningMessage returns null without a plan marker", () => {
    expect(splitPlanningMessage("### Planning turn 1\n\nWhat constraints apply?")).toBeNull();
  });

  it("normalizeReplyForPlanExtraction parses grok streaming stdout before plan extraction", () => {
    const log = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "grok-quality-gate-planning-stream.txt"),
      "utf8"
    );
    const normalized = normalizeReplyForPlanExtraction(log, "grok");
    expect(extractFinalPlan(normalized)).toContain("Bring `core` Domain to Grade A");
    expect(extractFinalPlan(log)).toBeUndefined();
  });

});
