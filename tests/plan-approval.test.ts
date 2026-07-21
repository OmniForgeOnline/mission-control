import { describe, expect, it } from "vitest";

import { canApprovePlan, extractPlanFromTask } from "../src/core/prompts/plan-approval.ts";
import type { HarnessTask } from "../src/core/types.ts";

function stubTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "task-1",
    title: "Task",
    description: "desc\n\n## Plan\n\n# Plan\nStep one",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [{ id: "1", author: "agent", body: "Plan ready.", createdAt: timestamp }],
    workflowRun: {
      workflowId: "code-feature",
      currentStepId: "plan",
      completedSteps: [],
      stepApprovals: {}
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const codeFeature = {
  steps: {
    plan: { kind: "conversation" },
    plan_gate: { kind: "agent_turn", agent: "none", approval: "required", next: "implement" },
    implement: { kind: "agent_turn", skill: "pr-driven-execution" }
  }
};

describe("canApprovePlan", () => {
  it("is true on a conversation step with a saved plan", () => {
    expect(canApprovePlan(stubTask(), codeFeature)).toBe(true);
  });

  it("is true when plan lives only in the latest agent message", () => {
    expect(
      canApprovePlan(
        stubTask({
          description: "No plan in description yet.",
          messages: [
            {
              id: "1",
              author: "agent",
              body: "<proposed_plan>\n# Plan\nStep one\n</proposed_plan>",
              createdAt: new Date().toISOString()
            }
          ],
          workflowRun: {
            workflowId: "code-feature",
            currentStepId: "plan",
            completedSteps: [],
            stepApprovals: {}
          }
        }),
        codeFeature
      )
    ).toBe(true);
  });

  it("is false without a plan section", () => {
    expect(canApprovePlan(stubTask({ description: "No plan yet.", messages: [] }), codeFeature)).toBe(false);
  });

  it("is false when the workflow has no implementation step", () => {
    expect(
      canApprovePlan(
        stubTask(),
        { steps: { scope: { kind: "conversation" } } }
      )
    ).toBe(false);
  });

  it("is true when queued at plan_gate with a saved plan", () => {
    const bugfix = {
      steps: {
        investigate: { kind: "agent_turn", modifiesRepo: false },
        plan_gate: {
          kind: "agent_turn" as const,
          agent: "none" as const,
          approval: "required" as const,
          next: "fix"
        },
        fix: {
          kind: "agent_turn" as const,
          agent: "grok" as const,
          approval: "required" as const,
          skill: "pr-driven-execution"
        }
      }
    };
    expect(
      canApprovePlan(
        stubTask({
          workflowRun: {
            workflowId: "bugfix",
            currentStepId: "plan_gate",
            completedSteps: ["investigate"],
            stepApprovals: {}
          }
        }),
        bugfix
      )
    ).toBe(true);
  });

  it("is true for bugfix on investigate with a saved plan", () => {
    const bugfix = {
      steps: {
        investigate: { kind: "agent_turn", modifiesRepo: false },
        plan_gate: {
          kind: "agent_turn" as const,
          agent: "none" as const,
          approval: "required" as const
        },
        fix: {
          kind: "agent_turn" as const,
          agent: "grok" as const,
          approval: "required" as const,
          skill: "pr-driven-execution"
        }
      }
    };
    expect(
      canApprovePlan(
        stubTask({
          workflowRun: {
            workflowId: "bugfix",
            currentStepId: "investigate",
            completedSteps: [],
            stepApprovals: {}
          }
        }),
        bugfix
      )
    ).toBe(true);
  });
});

describe("extractPlanFromTask", () => {
  it("reads plan markers from the latest agent message", () => {
    const task = stubTask({
      description: "desc only",
      messages: [
        {
          id: "1",
          author: "agent",
          body: "<proposed_plan>\n# Plan\nFrom message\n</proposed_plan>",
          createdAt: new Date().toISOString()
        }
      ]
    });
    expect(extractPlanFromTask(task)).toContain("From message");
  });

  it("prefers the latest agent message over a stale description plan section", () => {
    const task = stubTask({
      description: "desc\n\n## Plan\n\n# Plan\nStale description plan",
      messages: [
        {
          id: "1",
          author: "agent",
          body: "<proposed_plan>\n# Plan\nRefined message plan\n</proposed_plan>",
          createdAt: new Date().toISOString()
        }
      ]
    });
    expect(extractPlanFromTask(task)).toContain("Refined message plan");
    expect(extractPlanFromTask(task)).not.toContain("Stale description plan");
  });
});