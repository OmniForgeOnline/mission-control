import { describe, expect, it } from "vitest";

import {
  countStepComments,
  messagesForStep
} from "../src/ui/features/tasks/detail/workflow/step-messages.ts";
import { stepChatSubmission } from "../src/ui/features/tasks/detail/workflow/panel/step-chat.tsx";
import type { HarnessMessage, HarnessTask } from "../src/ui/app/types.ts";

function msg(
  partial: Partial<HarnessMessage> & Pick<HarnessMessage, "id" | "author" | "body">
): HarnessMessage {
  return {
    createdAt: "2026-06-06T10:00:00.000Z",
    ...partial
  };
}

function task(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "task-1",
    title: "Example",
    description: "",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedAt: "2026-06-06T10:00:00.000Z",
    ...overrides
  };
}

describe("workflow step messages", () => {
  it("groups agent replies with the scoped operator message", () => {
    const messages = [
      msg({ id: "1", author: "operator", body: "Check pagination edge cases", stepId: "unit" }),
      msg({ id: "2", author: "agent", body: "Running the unit suite now." }),
      msg({ id: "3", author: "operator", body: "Global note" })
    ];

    expect(messagesForStep(messages, "unit").map((m) => m.id)).toEqual(["1", "2"]);
    expect(countStepComments(messages, "unit")).toBe(1);
  });

  it("supports legacy bracket prefixes", () => {
    const messages = [
      msg({ id: "1", author: "operator", body: "[lint] fix the import order" }),
      msg({ id: "2", author: "agent", body: "On it." })
    ];

    expect(messagesForStep(messages, "lint").map((m) => m.id)).toEqual(["1", "2"]);
    expect(countStepComments(messages, "lint")).toBe(1);
  });

  it("does not leak unscoped messages into arbitrary steps", () => {
    const messages = [
      msg({ id: "1", author: "operator", body: "Global note" }),
      msg({ id: "2", author: "agent", body: "General reply" }),
      msg({ id: "3", author: "system", body: "Workflow event" })
    ];

    expect(messagesForStep(messages, "implement")).toEqual([]);
    expect(countStepComments(messages, "implement")).toBe(0);
  });

  it("keeps completed step conversation available from explicit step ids", () => {
    const messages = [
      msg({ id: "1", author: "agent", body: "Plan ready.", stepId: "plan" }),
      msg({ id: "2", author: "operator", body: "Looks good.", stepId: "plan" }),
      msg({ id: "3", author: "system", body: "Plan approved.", stepId: "plan_gate" })
    ];

    expect(messagesForStep(messages, "plan").map((m) => m.id)).toEqual(["1", "2"]);
    expect(messagesForStep(messages, "plan_gate").map((m) => m.id)).toEqual(["3"]);
  });

  it("submits active step chat as an actionable message to that step's agent", () => {
    const submission = stepChatSubmission(
      task({
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          activeStepIds: ["implement"],
          completedSteps: [],
          stepApprovals: {}
        }
      }),
      "implement",
      "Please check the failing case."
    );

    expect(submission).toEqual({
      runAfterPost: true,
      requestBody: {
        author: "operator",
        body: "Please check the failing case.",
        stepId: "implement"
      }
    });
  });

  it("keeps inactive step chat as a scoped note", () => {
    const submission = stepChatSubmission(
      task({
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          activeStepIds: ["implement"],
          completedSteps: [],
          stepApprovals: {}
        }
      }),
      "review",
      "Save this for review."
    );

    expect(submission).toEqual({
      runAfterPost: false,
      requestBody: {
        author: "operator",
        body: "Save this for review.",
        stepId: "review",
        noteOnly: true
      }
    });
  });
});
