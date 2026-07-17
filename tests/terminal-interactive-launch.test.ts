import { describe, expect, it } from "vitest";

import { normalizeTool, normalizeModelPool } from "../src/core/agents/config/normalize.ts";
import {
  buildInteractiveLaunch,
  buildShellLaunch,
  interactivePromptArgv,
  INTERACTIVE_PROMPT_ARGV_MAX_BYTES
} from "../src/terminal/interactive-launch.ts";

describe("interactive launch builders", () => {
  it("returns null for ACP tools (no interactive TUI path in v1)", () => {
    const acp = normalizeTool({
      id: "kiro",
      adapter: "acp",
      command: "kiro-cli",
      enabled: true,
      displayName: "Kiro",
      cli: {}
    });
    expect(buildInteractiveLaunch(acp, null, process.cwd())).toBeNull();
  });

  it("builds a shell launch with interactive flag and terminal env", () => {
    const shell = buildShellLaunch("/tmp/project");
    expect(shell.command).toBeTruthy();
    expect(shell.args).toContain("-i");
    expect(shell.env["TERM"]).toBe("xterm-256color");
    expect(shell.env["PWD"]).toBe("/tmp/project");
  });

  it("rejects unknown binary for interactive agent launch", () => {
    const tool = normalizeTool({
      id: "nope-agent",
      adapter: "claude",
      command: "definitely-not-a-real-agent-binary-xyz",
      enabled: true,
      displayName: "Nope",
      cli: {},
      fallbackCommands: []
    });
    expect(() => buildInteractiveLaunch(tool, null, process.cwd())).toThrow(/not found|Failed to resolve/i);
  });

  it("applies codex model args, effort, plan sandbox, and the harness prompt as argv", () => {
    const tool = normalizeTool({
      id: "codex",
      adapter: "codex",
      command: "/bin/echo",
      enabled: true,
      displayName: "Codex",
      cli: {
        effortConfigKey: "model_reasoning_effort",
        permissionModes: { plan: "read-only", execute: "workspace-write" }
      },
      fallbackCommands: []
    });
    const pool = normalizeModelPool({
      id: "codex-luna",
      toolId: "codex",
      enabled: true,
      displayName: "Luna",
      modelArgs: ["--model", "gpt-5.6-luna"]
    });
    const launch = buildInteractiveLaunch(tool, pool, process.cwd(), {
      effort: "high",
      mode: "plan",
      prompt: "Write a plan for the feature"
    });
    expect(launch).not.toBeNull();
    expect(launch!.args).toEqual(
      expect.arrayContaining([
        "-c",
        "model_reasoning_effort=high",
        "--model",
        "gpt-5.6-luna",
        "-s",
        "read-only",
        "Write a plan for the feature"
      ])
    );
    // Interactive codex must not use `exec` (that is the headless path).
    expect(launch!.args).not.toContain("exec");
    // Prompt is the last argv so the TUI starts the same work headless would.
    expect(launch!.args.at(-1)).toBe("Write a plan for the feature");
  });

  it("applies claude model, effort flag, plan permission mode, and prompt argv", () => {
    const tool = normalizeTool({
      id: "claude",
      adapter: "claude",
      command: "/bin/echo",
      enabled: true,
      displayName: "Claude",
      cli: { effortFlag: "--effort" },
      fallbackCommands: []
    });
    const pool = normalizeModelPool({
      id: "claude-sonnet",
      toolId: "claude",
      enabled: true,
      displayName: "Sonnet",
      modelArgs: ["--model", "sonnet"]
    });
    const launch = buildInteractiveLaunch(tool, pool, process.cwd(), {
      effort: "high",
      mode: "plan",
      sessionId: "sess-1",
      prompt: "Plan the migration"
    });
    expect(launch).not.toBeNull();
    expect(launch!.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "plan",
        "--effort",
        "high",
        "--model",
        "sonnet",
        "--resume",
        "sess-1",
        "Plan the migration"
      ])
    );
    expect(launch!.args).not.toContain("-p");
    expect(launch!.args.at(-1)).toBe("Plan the migration");
  });

  it("falls back to promptFile when the prompt is too large for argv", () => {
    const big = "x".repeat(INTERACTIVE_PROMPT_ARGV_MAX_BYTES + 100);
    const argv = interactivePromptArgv(big, "/tmp/run/prompt.md");
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain("/tmp/run/prompt.md");
    expect(argv[0]!.length).toBeLessThan(big.length);
  });
});
