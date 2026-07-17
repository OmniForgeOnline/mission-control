import { afterEach, describe, expect, it } from "vitest";

import { normalizeTool, normalizeModelPool } from "../src/core/agents/config/normalize.ts";
import {
  createSessionManager,
  type PtyHandle,
  type PtySpawnOptions
} from "../src/terminal/session-manager.ts";
import { setTerminalSessionManagerForTests } from "../src/terminal/manager.ts";
import {
  completeInteractiveTurn,
  resetInteractiveControlForTests
} from "../src/terminal/interactive-control.ts";
import { InteractiveAgentRunner } from "../src/runners/interactive.ts";

const spawnCalls: PtySpawnOptions[] = [];
const exitHandlers: Array<(info: { exitCode: number; signal?: number }) => void> = [];

function fakeSpawn(opts: PtySpawnOptions): PtyHandle {
  spawnCalls.push(opts);
  return {
    pid: 42,
    cols: opts.cols,
    rows: opts.rows,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit(cb) {
      exitHandlers.push(cb);
    }
  };
}

describe("InteractiveAgentRunner", () => {
  afterEach(() => {
    resetInteractiveControlForTests();
    setTerminalSessionManagerForTests(null);
    spawnCalls.length = 0;
    exitHandlers.length = 0;
  });

  it("waits for operator Done and returns interactive outcome", async () => {
    setTerminalSessionManagerForTests(createSessionManager({ spawn: fakeSpawn }));

    // buildInteractiveLaunch resolves via login-shell `command -v`. Use /bin/echo
    // (present on macOS and Linux CI); /bin/zsh is not guaranteed in CI images.
    const tool = normalizeTool({
      id: "shell-agent",
      adapter: "generic",
      command: "/bin/echo",
      enabled: true,
      displayName: "Shell",
      cli: {},
      fallbackCommands: []
    });
    const pool = normalizeModelPool({
      id: "shell-default",
      toolId: "shell-agent",
      enabled: true,
      displayName: "Default",
      modelArgs: []
    });

    const runner = new InteractiveAgentRunner("shell-agent", { tool, pool });
    const turn = runner.runTurn({
      task: {
        id: "task-int-1",
        title: "Test",
        description: "desc",
        agent: "shell-agent",
        source: "manual",
        links: [],
        targets: [],
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      prompt: "Do the thing",
      cwd: process.cwd(),
      turnNumber: 1,
      runId: "run-int-1",
      runDir: "/tmp/run-int-1"
    });

    // Yield so the runner registers the waiter and creates the session.
    await new Promise((r) => setTimeout(r, 50));
    expect(completeInteractiveTurn("task-int-1", { kind: "done", note: "all good" })).toBe(true);

    const result = await turn;
    expect(result.interactive).toBe(true);
    expect(result.operatorOutcome).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.reply).toContain("all good");
    // Prompt is on the spawn argv (same session the UI attaches to) — not a
    // separate headless process and not a post-start PTY paste.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain("Do the thing");
  });

  it("auto-completes authoring turns when the agent process exits successfully", async () => {
    setTerminalSessionManagerForTests(createSessionManager({ spawn: fakeSpawn }));

    const tool = normalizeTool({
      id: "shell-agent",
      adapter: "generic",
      command: "/bin/echo",
      enabled: true,
      displayName: "Shell",
      cli: {},
      fallbackCommands: []
    });
    const pool = normalizeModelPool({
      id: "shell-default",
      toolId: "shell-agent",
      enabled: true,
      displayName: "Default",
      modelArgs: []
    });

    const runner = new InteractiveAgentRunner("shell-agent", { tool, pool });
    // mode omitted = execute/authoring (not plan). Auto-advance on process exit.
    const turn = runner.runTurn({
      task: {
        id: "task-int-exit",
        title: "Implement",
        description: "desc",
        agent: "shell-agent",
        source: "manual",
        links: [],
        targets: [],
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      prompt: "Ship it",
      cwd: process.cwd(),
      turnNumber: 1,
      runId: "run-int-exit"
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0]!({ exitCode: 0 });

    const result = await turn;
    expect(result.interactive).toBe(true);
    expect(result.operatorOutcome).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.reply).toMatch(/exited|advancing/i);
  });

  it("does not auto-complete planning turns on process exit", async () => {
    setTerminalSessionManagerForTests(createSessionManager({ spawn: fakeSpawn }));

    const tool = normalizeTool({
      id: "shell-agent",
      adapter: "generic",
      command: "/bin/echo",
      enabled: true,
      displayName: "Shell",
      cli: {},
      fallbackCommands: []
    });
    const pool = normalizeModelPool({
      id: "shell-default",
      toolId: "shell-agent",
      enabled: true,
      displayName: "Default",
      modelArgs: []
    });

    const runner = new InteractiveAgentRunner("shell-agent", { tool, pool });
    const turn = runner.runTurn({
      task: {
        id: "task-int-plan",
        title: "Plan",
        description: "desc",
        agent: "shell-agent",
        source: "manual",
        links: [],
        targets: [],
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      prompt: "Plan it",
      mode: "plan",
      cwd: process.cwd(),
      turnNumber: 1,
      runId: "run-int-plan"
    });

    await new Promise((r) => setTimeout(r, 50));
    exitHandlers[0]!({ exitCode: 0 });
    // Still waiting for operator Done.
    await new Promise((r) => setTimeout(r, 30));
    expect(completeInteractiveTurn("task-int-plan", { kind: "done", note: "plan ok" })).toBe(true);

    const result = await turn;
    expect(result.operatorOutcome).toBe("done");
    expect(result.reply).toContain("plan ok");
  });
});
