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
    onExit() {}
  };
}

describe("InteractiveAgentRunner", () => {
  afterEach(() => {
    resetInteractiveControlForTests();
    setTerminalSessionManagerForTests(null);
    spawnCalls.length = 0;
  });

  it("waits for operator Done and returns interactive outcome", async () => {
    setTerminalSessionManagerForTests(createSessionManager({ spawn: fakeSpawn }));

    // Avoid resolveCommandBinary by using absolute path that still fails resolve
    // unless we mock — InteractiveAgentRunner uses buildInteractiveLaunch which
    // resolves the binary. Stub via generic adapter with absolute command that
    // exists: /bin/zsh.
    const tool = normalizeTool({
      id: "shell-agent",
      adapter: "generic",
      command: "/bin/zsh",
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
});
