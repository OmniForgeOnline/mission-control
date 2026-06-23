import { describe, expect, it } from "vitest";

import { HeadlessAgentRunner, type RunnerLaunchContext } from "../src/runners/headless.ts";
import { buildLaunchArgs, type LaunchRequest } from "../src/runners/adapter.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../src/core/agents/config/types.ts";

function builtinTool(id: string): AgentToolConfig {
  return builtinAgentConfigBundle().tools.find((tool) => tool.id === id)!;
}

function emptyPool(toolId: string): ModelPoolConfig {
  return {
    id: `${toolId}-default`,
    toolId,
    displayName: toolId,
    modelArgs: [],
    modelEnv: {},
    capabilities: [],
    qualityWeight: 50,
    tier: "paid",
    usage: { kind: "usage-only" },
    usageSource: "none",
    enabled: true,
    builtin: true
  };
}

function launchContext(id: string): RunnerLaunchContext {
  return { tool: builtinTool(id), pool: emptyPool(id) };
}

function makeRunner(id: string): HeadlessAgentRunner {
  return new HeadlessAgentRunner(id, launchContext(id));
}

function launch(id: string, request: LaunchRequest) {
  return buildLaunchArgs(builtinTool(id), emptyPool(id), request);
}

describe("headless runner workspace args", () => {
  it("pins codex and claude to the requested workspace in plan mode", () => {
    const codexArgs = launch("codex", {
      mode: "plan",
      prompt: "Plan this feature",
      cwd: "/tmp/llm-fleet",
      effort: "high"
    });
    expect(codexArgs.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/tmp/llm-fleet",
      "-c",
      "model_reasoning_effort=high",
      "-s",
      "read-only"
    ]);

    const codexResumeArgs = launch("codex", {
      mode: "plan",
      prompt: "Plan this feature",
      cwd: "/tmp/llm-fleet",
      effort: "high",
      sessionId: "thread-abc-123"
    });
    expect(codexResumeArgs.args).toEqual([
      "exec",
      "resume",
      "thread-abc-123",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "model_reasoning_effort=high"
    ]);

    const claudeArgs = launch("claude", {
      mode: "plan",
      prompt: "Plan this feature",
      cwd: "/tmp/llm-fleet",
      effort: "high",
      allowedDirs: ["/tmp/harness"]
    });
    expect(claudeArgs.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--verbose",
      "--permission-mode",
      "plan",
      "--add-dir",
      "/tmp/llm-fleet",
      "--add-dir",
      "/tmp/harness",
      "--effort",
      "high"
    ]);
  });
});

describe("grok runner", () => {
  it("ignores task effort because grok does not support reasoning effort", () => {
    const args = launch("grok", { mode: "plan", prompt: "Plan this feature", cwd: "/tmp", effort: "high" });
    expect(args.args).not.toContain("--effort");
  });

  it("builds plan and execute args correctly", () => {
    const planArgs = launch("grok", { mode: "plan", prompt: "Plan this feature", cwd: "/tmp" });
    expect(planArgs.promptOnStdin).toBe(false);
    expect(planArgs.args).toEqual([
      "--single",
      "Plan this feature",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "plan",
      "--cwd",
      "/tmp"
    ]);

    const execArgs = launch("grok", { mode: "execute", prompt: "Plan this feature", cwd: "/tmp", sessionId: "sess-9" });
    expect(execArgs.args).toEqual([
      "--single",
      "Plan this feature",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
      "--cwd",
      "/tmp",
      "--always-approve",
      "--resume",
      "sess-9"
    ]);
  });

  it("parses codex item.completed agent_message events and thread_id", () => {
    const runner = makeRunner("codex");
    const parseOutput = (
      runner as unknown as {
        parseOutput(stdout: string, stderr: string): { reply: string; sessionId?: string };
      }
    ).parseOutput;

    const planText =
      "FINAL_PLAN:\n\n<proposed_plan>\n# Core plan\n\nAdd tests for src/core.\n</proposed_plan>";
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-abc-123" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: planText }
      }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 42 } })
    ].join("\n");

    const parsed = parseOutput.call(runner, stdout, "");
    expect(parsed.reply).toBe(planText);
    expect(parsed.sessionId).toBe("thread-abc-123");
  });

  it("parses streaming JSON reply and session id defensively", () => {
    const runner = makeRunner("grok");
    const parseOutput = (
      runner as unknown as {
        parseOutput(stdout: string, stderr: string): { reply: string; sessionId?: string };
      }
    ).parseOutput;

    const stdout = [
      JSON.stringify({ type: "assistant", text: "Working on it" }),
      JSON.stringify({ type: "result", result: "Final plan", session_id: "grok-sess-1" })
    ].join("\n");

    const parsed = parseOutput.call(runner, stdout, "");
    expect(parsed.reply).toBe("Final plan");
    expect(parsed.sessionId).toBe("grok-sess-1");

    const fallback = parseOutput.call(runner, "plain stdout fallback", "");
    expect(fallback.reply).toBe("plain stdout fallback");
  });
});
