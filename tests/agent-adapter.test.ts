import { describe, expect, it } from "vitest";

import { buildLaunchArgs, type LaunchRequest } from "../src/runners/adapter.ts";
import { normalizeModelPool, normalizeTool } from "../src/core/agents/config/normalize.ts";
import {
  agentSessionFromTurn,
  canResumeAgentSession
} from "../src/core/agents/session.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import type { HarnessTask } from "../src/core/types.ts";

const request: LaunchRequest = { mode: "execute", prompt: "do it", cwd: "/work" };

describe("generic runner adapter", () => {
  it("expands the command template and injects model args + env", () => {
    const tool = normalizeTool({
      id: "kilo-cli",
      command: "kilo",
      adapter: "generic",
      commandTemplate: ["run", "--prompt", "{prompt}", "--model", "{model}", "--dir", "{cwd}"]
    });
    const pool = normalizeModelPool({
      id: "kilo-free",
      toolId: "kilo-cli",
      modelArgs: ["glm-5.1"],
      modelEnv: { ZAI_BASE_URL: "https://api.z.ai" },
      tier: "free",
      capabilities: ["author"]
    });
    const spec = buildLaunchArgs(tool, pool, request);
    expect(spec.args).toEqual(["run", "--prompt", "do it", "--model", "glm-5.1", "--dir", "/work"]);
    expect(spec.env).toEqual({ ZAI_BASE_URL: "https://api.z.ai" });
    // Template consumes {prompt}, so the prompt is not also sent on stdin.
    expect(spec.promptOnStdin).toBe(false);
  });

  it("falls back to stdin and appends model args when the template omits tokens", () => {
    const tool = normalizeTool({
      id: "warp",
      command: "warp",
      adapter: "generic",
      commandTemplate: ["exec"]
    });
    const pool = normalizeModelPool({
      id: "warp-pro",
      toolId: "warp",
      modelArgs: ["--model", "claude-sonnet"],
      tier: "paid",
      capabilities: ["author"]
    });
    const spec = buildLaunchArgs(tool, pool, request);
    expect(spec.args).toEqual(["exec", "--model", "claude-sonnet"]);
    expect(spec.promptOnStdin).toBe(true);
  });
});

describe("opencode runner adapter", () => {
  it("emits run subcommand and sends prompt over stdin", () => {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "opencode")!;
    const pool = bundle.pools.find((p) => p.id === "opencode-default")!;
    const spec = buildLaunchArgs(tool, pool, request);
    expect(spec.args).toContain("run");
    expect(spec.args).not.toContain("do it");
    expect(spec.args).toContain("--format");
    expect(spec.args).toContain("json");
    expect(spec.args).toContain("--dir");
    expect(spec.args).toContain("/work");
    expect(spec.args).toContain("--dangerously-skip-permissions");
    expect(spec.promptOnStdin).toBe(true);
  });

  it("uses --variant for effort and --dangerously-skip-permissions in execute mode", () => {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "opencode")!;
    const pool = bundle.pools.find((p) => p.id === "opencode-default")!;
    const spec = buildLaunchArgs(tool, pool, { ...request, effort: "high" });
    expect(spec.args).toContain("--variant");
    const variantIdx = spec.args.indexOf("--variant");
    expect(spec.args[variantIdx + 1]).toBe("high");
    expect(spec.args).toContain("--dangerously-skip-permissions");
  });

  it("uses --session for resume and does not include prompt", () => {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "opencode")!;
    const pool = bundle.pools.find((p) => p.id === "opencode-default")!;
    const spec = buildLaunchArgs(tool, pool, { ...request, sessionId: "sess-42" });
    expect(spec.args).toContain("--session");
    const sessionIdx = spec.args.indexOf("--session");
    expect(spec.args[sessionIdx + 1]).toBe("sess-42");
  });

  it("drops --dangerously-skip-permissions in plan mode", () => {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "opencode")!;
    const pool = bundle.pools.find((p) => p.id === "opencode-default")!;
    const spec = buildLaunchArgs(tool, pool, { ...request, mode: "plan" });
    expect(spec.args).not.toContain("--dangerously-skip-permissions");
    expect(spec.args).not.toContain("--variant");
  });
});

describe("claude runner adapter", () => {
  function claudeSpec(mode: LaunchRequest["mode"]) {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "claude")!;
    const pool = bundle.pools.find((p) => p.toolId === "claude")!;
    return buildLaunchArgs(tool, pool, { ...request, mode });
  }

  it("uses --permission-mode plan in plan mode", () => {
    const args = claudeSpec("plan").args;
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("classify mode uses default permission (no planning session, not execute)", () => {
    const args = claudeSpec("classify").args;
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("execute mode bypasses permissions", () => {
    const args = claudeSpec("execute").args;
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });
});

describe("codex runner adapter", () => {
  it("classify mode reuses the read-only sandbox", () => {
    const bundle = builtinAgentConfigBundle();
    const tool = bundle.tools.find((t) => t.id === "codex")!;
    const pool = bundle.pools.find((p) => p.id === "codex-default")!;
    const spec = buildLaunchArgs(tool, pool, { ...request, mode: "classify" });
    expect(spec.args).toContain("-s");
    expect(spec.args[spec.args.indexOf("-s") + 1]).toBe("read-only");
  });
});

describe("session isolation by tool and model pool", () => {
  function taskWith(agent: string, modelPool?: string): HarnessTask {
    const ts = new Date().toISOString();
    return {
      id: "t1",
      title: "t",
      description: "d",
      agent,
      source: "manual",
      links: [],
      targets: [],
      messages: [],
      createdAt: ts,
      updatedAt: ts,
      ...agentSessionFromTurn("sess-1", agent, false, modelPool)
    };
  }

  it("resumes only when both tool and model pool match", () => {
    const task = taskWith("claude", "claude-zai");
    expect(canResumeAgentSession(task, { agent: "claude", modelPool: "claude-zai", conversation: false })).toBe(true);
    expect(canResumeAgentSession(task, { agent: "claude", modelPool: "claude-default", conversation: false })).toBe(false);
    expect(canResumeAgentSession(task, { agent: "codex", modelPool: "claude-zai", conversation: false })).toBe(false);
  });
});
