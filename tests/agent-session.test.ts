import { describe, expect, it } from "vitest";

import {
  agentSessionFromTurn,
  canResumeAgentSession,
  clearAgentSession,
  hashStableInstructions
} from "../src/core/agents/session.ts";
import type { HarnessTask } from "../src/core/types.ts";

function stubTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "task-1",
    title: "Task",
    description: "desc",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    agentSessionId: "sess-plan-1",
    agentSessionAgent: "grok",
    agentSessionConversation: true,
    ...overrides
  };
}

describe("agent session resume", () => {
  it("resumes only for the same agent and conversation mode", () => {
    expect(canResumeAgentSession(stubTask(), { agent: "grok", conversation: true })).toBe(true);
    expect(canResumeAgentSession(stubTask(), { agent: "grok", conversation: false })).toBe(false);
    expect(canResumeAgentSession(stubTask(), { agent: "codex", conversation: true })).toBe(false);
  });

  it("clears stored session metadata", () => {
    expect(clearAgentSession()).toEqual({
      agentSessionId: undefined,
      agentSessionAgent: undefined,
      agentSessionConversation: undefined
    });
  });

  it("records session metadata from a completed turn", () => {
    expect(agentSessionFromTurn("sess-2", "grok", false, "grok-default", "stable-hash")).toEqual({
      agentSessionId: "sess-2",
      agentSessionAgent: "grok",
      agentSessionModelPool: "grok-default",
      agentSessionConversation: false,
      agentSessionStableHash: "stable-hash"
    });
  });

  it("resumes only when the stable instruction hash still matches", () => {
    const task = stubTask({ agentSessionStableHash: hashStableInstructions("rules v1") });
    expect(
      canResumeAgentSession(task, {
        agent: "grok",
        conversation: true,
        stableHash: hashStableInstructions("rules v1")
      })
    ).toBe(true);
    expect(
      canResumeAgentSession(task, {
        agent: "grok",
        conversation: true,
        stableHash: hashStableInstructions("rules v2")
      })
    ).toBe(false);
  });
});
