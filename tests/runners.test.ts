import { describe, expect, it } from "vitest";

import { createAgentRunner } from "../src/runners/index.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { HeadlessAgentRunner, formatSpawnNotice, type RunnerLaunchContext } from "../src/runners/headless.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import type { HarnessTask } from "../src/core/types.ts";
import type { AgentTurnRequest } from "../src/runners/types.ts";

function launchContext(id: string): RunnerLaunchContext {
  const bundle = builtinAgentConfigBundle();
  return {
    tool: bundle.tools.find((tool) => tool.id === id)!,
    pool: bundle.pools.find((pool) => pool.toolId === id)!
  };
}

function stubTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "task-runners-1",
    title: "Runners task",
    description: "desc",
    agent: "claude",
    source: "manual",
    links: [],
    targets: [{ raw: "src/runners", path: "src/runners", kind: "directory" }],
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    effort: "medium",
    ...overrides
  };
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    task: stubTask(),
    prompt: "Plan this feature",
    cwd: "/tmp/workspace",
    turnNumber: 1,
    ...overrides
  };
}

describe("createAgentRunner", () => {
  it("returns HeadlessAgentRunner for headless tools", () => {
    const runner = createAgentRunner("grok", launchContext("grok"));
    expect(runner).toBeInstanceOf(HeadlessAgentRunner);
    expect(runner.agent).toBe("grok");
  });

  it("requires a launch context", () => {
    expect(() => createAgentRunner("claude")).toThrow(
      'A launch context (tool + model pool) is required to run "claude".'
    );
  });
});

describe("formatSpawnNotice", () => {
  // The spawn log must disambiguate concurrent agent turns (e.g. quickstarts +
  // quality-gate both fire on onboarding) and surface retries, since the prompt
  // travels over stdin and the command line is otherwise identical across turns.
  const cmd = "claude -p --output-format stream-json --add-dir /repo";

  it("includes the label and turn number when a label is present", () => {
    expect(formatSpawnNotice("claude", 1, "quality-gate", cmd)).toBe(
      "[claude] spawning (quality-gate, turn 1): claude -p --output-format stream-json --add-dir /repo"
    );
  });

  it("falls back to just the turn number when no label is set", () => {
    expect(formatSpawnNotice("grok", 2, undefined, cmd)).toBe(
      "[grok] spawning (turn 2): claude -p --output-format stream-json --add-dir /repo"
    );
  });
});

describe("DeterministicAgentRunner", () => {
  it("returns default canned reply when no replies are configured", async () => {
    const runner = new DeterministicAgentRunner("grok");
    const result = await runner.runTurn(baseRequest({ turnNumber: 2 }));

    expect(result.reply).toBe('Deterministic grok reply for "Runners task" (turn 2).');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("test-task-runners-1");
    expect(result.command).toBe("deterministic grok 2");
  });

  it("sequences setReplies across turns and resets index", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies(["first", "second"]);

    const first = await runner.runTurn(baseRequest({ turnNumber: 1 }));
    const second = await runner.runTurn(baseRequest({ turnNumber: 2 }));
    const third = await runner.runTurn(baseRequest({ turnNumber: 3 }));

    expect(first.reply).toBe("first");
    expect(second.reply).toBe("second");
    expect(third.reply).toBe('Deterministic claude reply for "Runners task" (turn 3).');

    runner.setReplies(["reset"]);
    const reset = await runner.runTurn(baseRequest({ turnNumber: 4 }));
    expect(reset.reply).toBe("reset");
  });

  it("echoes prompt length, cwd, and targets in rawLog", async () => {
    const runner = new DeterministicAgentRunner("claude");
    const request = baseRequest({
      prompt: "x".repeat(42),
      cwd: "/tmp/custom-cwd",
      task: stubTask({
        targets: [
          { raw: "src/a", path: "src/a", kind: "directory" },
          { raw: "src/b", path: "src/b", kind: "file" }
        ]
      })
    });

    const result = await runner.runTurn(request);

    expect(result.rawLog).toContain("Prompt length: 42");
    expect(result.rawLog).toContain("Cwd: /tmp/custom-cwd");
    expect(result.rawLog).toContain("Targets: src/a, src/b");
  });

  it("reports none when task has no targets", async () => {
    const runner = new DeterministicAgentRunner("claude");
    const result = await runner.runTurn(
      baseRequest({ task: stubTask({ targets: [] }) })
    );

    expect(result.rawLog).toContain("Targets: none");
  });

  it("invokes onActivity and onOutput callbacks", async () => {
    const runner = new DeterministicAgentRunner("claude");
    const activities: string[] = [];
    const outputs: string[] = [];

    await runner.runTurn(
      baseRequest({
        onActivity: (activity) => activities.push(activity.label),
        onOutput: (chunk) => outputs.push(chunk)
      })
    );

    expect(activities).toEqual(["writing a response"]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain("Prompt length:");
  });

  it("uses provided sessionId when present", async () => {
    const runner = new DeterministicAgentRunner("claude");
    const result = await runner.runTurn(baseRequest({ sessionId: "session-abc" }));
    expect(result.sessionId).toBe("session-abc");
  });

  it("abort is a no-op", () => {
    const runner = new DeterministicAgentRunner("claude");
    expect(() => runner.abort()).not.toThrow();
  });
});
