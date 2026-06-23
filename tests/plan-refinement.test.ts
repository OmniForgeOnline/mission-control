import { describe, expect, it } from "vitest";

import {
  canRefinePlan,
  findPlanningConversationStepId,
  isPreImplementationReview,
  rewindWorkflowForPlanRefinement,
  workflowStageLabel
} from "../src/core/prompts/plan-refinement.ts";
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
    messages: [
      {
        id: "1",
        author: "agent",
        body: "<proposed_plan>\n# Plan\nStep one\n</proposed_plan>",
        createdAt: timestamp
      }
    ],
    workflowRun: {
      workflowId: "code-feature",
      currentStepId: "plan_gate",
      completedSteps: ["plan"],
      stepApprovals: {}
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const codeFeature = {
  steps: {
    plan: { kind: "conversation", next: "plan_gate" },
    plan_gate: { kind: "agent_turn", agent: "none", approval: "required", next: "implement" },
    implement: { kind: "agent_turn", skill: "pr-driven-execution", approval: "required" }
  }
};

describe("canRefinePlan", () => {
  it("is true on a conversation step awaiting operator feedback", () => {
    expect(
      canRefinePlan(
        stubTask({
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

  it("is true when queued at plan_gate with a saved plan", () => {
    expect(canRefinePlan(stubTask(), codeFeature)).toBe(true);
  });

  it("is true when queued at implement before repo work starts", () => {
    expect(
      canRefinePlan(
        stubTask({
          workflowRun: {
            workflowId: "code-feature",
            currentStepId: "implement",
            completedSteps: ["plan", "plan_gate"],
            stepApprovals: {
              plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: new Date().toISOString() }
            }
          }
        }),
        codeFeature
      )
    ).toBe(true);
  });

  it("is false at implement once a branch exists", () => {
    expect(
      canRefinePlan(
        stubTask({
          branch: "feat/example",
          workflowRun: {
            workflowId: "code-feature",
            currentStepId: "implement",
            completedSteps: ["plan", "plan_gate"],
            stepApprovals: {}
          }
        }),
        codeFeature
      )
    ).toBe(false);
  });

  it("is false without a plan", () => {
    expect(
      canRefinePlan(
        stubTask({ description: "No plan yet.", messages: [] }),
        codeFeature
      )
    ).toBe(false);
  });
});

describe("rewindWorkflowForPlanRefinement", () => {
  it("rewinds from plan_gate to the planning conversation step", () => {
    const run = stubTask().workflowRun!;
    const rewound = rewindWorkflowForPlanRefinement(codeFeature, run);
    expect(rewound?.currentStepId).toBe("plan");
    expect(rewound?.completedSteps).toEqual([]);
    expect(rewound?.stepApprovals).toEqual({});
  });

  it("rewinds from implement pre-code to plan", () => {
    const run = stubTask({
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "implement",
        completedSteps: ["plan", "plan_gate"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: new Date().toISOString() }
        }
      }
    }).workflowRun!;
    const rewound = rewindWorkflowForPlanRefinement(codeFeature, run);
    expect(rewound?.currentStepId).toBe("plan");
    expect(rewound?.completedSteps).toEqual([]);
  });
});

describe("findPlanningConversationStepId", () => {
  it("finds plan from plan_gate", () => {
    const run = stubTask().workflowRun!;
    expect(findPlanningConversationStepId(codeFeature, run)).toBe("plan");
  });
});

describe("isPreImplementationReview", () => {
  it("is true when queued on implement with a plan and no branch", () => {
    expect(
      isPreImplementationReview(
        stubTask({
          workflowRun: {
            workflowId: "code-feature",
            currentStepId: "implement",
            completedSteps: ["plan", "plan_gate"],
            stepApprovals: {}
          }
        }),
        codeFeature
      )
    ).toBe(true);
  });
});

describe("workflowStageLabel", () => {
  it("maps known step ids to readable labels", () => {
    expect(workflowStageLabel("plan_gate")).toBe("Plan review");
    expect(workflowStageLabel("implement")).toBe("Implementation");
  });
});