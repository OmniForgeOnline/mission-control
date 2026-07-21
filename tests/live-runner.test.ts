import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { appendRunEvent, readRunEvents, subscribeRunEvents } from "../src/core/runs/events.ts";
import { runEventsFromStreamEvent } from "../src/core/runs/normalize-events.ts";
import { normalizeTool } from "../src/core/agents/config/normalize.ts";

describe("run event sink", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-live-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends events with monotonic seq and replays from an offset", async () => {
    const first = await appendRunEvent(root, "run-a", { type: "text_delta", text: "hello" });
    const second = await appendRunEvent(root, "run-a", { type: "text_delta", text: " world" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const all = await readRunEvents(root, "run-a");
    expect(all.map((event) => event.text)).toEqual(["hello", " world"]);

    const afterFirst = await readRunEvents(root, "run-a", 1);
    expect(afterFirst.map((event) => event.text)).toEqual([" world"]);
  });

  it("emits appended events to live subscribers until unsubscribed", async () => {
    const received: string[] = [];
    const unsubscribe = subscribeRunEvents("run-b", (event) => {
      if (event.text) received.push(event.text);
    });

    await appendRunEvent(root, "run-b", { type: "text_delta", text: "x" });
    unsubscribe();
    await appendRunEvent(root, "run-b", { type: "text_delta", text: "y" });

    expect(received).toEqual(["x"]);
  });
});

describe("agent stream event normalizer", () => {
  it("maps claude assistant text and tool_use parts", () => {
    const events = runEventsFromStreamEvent("claude", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Working on it" },
          { type: "tool_use", name: "Edit", input: { file_path: "/repo/x.ts" } }
        ]
      }
    });
    const types = events.map((event) => event.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_call");
    expect(events.find((event) => event.type === "tool_call")?.tool).toBe("Edit");
  });

  it("maps claude tool_result and session id", () => {
    const result = runEventsFromStreamEvent("claude", {
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] }
    });
    expect(result.map((event) => event.type)).toContain("tool_result");

    const session = runEventsFromStreamEvent("claude", {
      type: "system",
      subtype: "init",
      session_id: "sess-1"
    });
    expect(session.find((event) => event.type === "session_id")?.sessionId).toBe("sess-1");
  });

  it("maps codex reasoning and agent_message events", () => {
    const reasoning = runEventsFromStreamEvent("codex", {
      msg: { type: "agent_reasoning", text: "thinking through it" }
    });
    expect(reasoning.map((event) => event.type)).toContain("thinking_delta");

    const message = runEventsFromStreamEvent("codex", {
      msg: { type: "agent_message", message: "done" }
    });
    expect(message.find((event) => event.type === "text_delta")?.text).toBe("done");
  });

  it("maps grok text and thought events", () => {
    const text = runEventsFromStreamEvent("grok", { type: "text", data: "chunk" });
    expect(text).toEqual([{ type: "text_delta", text: "chunk" }]);

    const thought = runEventsFromStreamEvent("grok", { type: "thought", data: "hmm" });
    expect(thought.map((event) => event.type)).toContain("thinking_delta");
  });

  it("returns nothing for unrecognized shapes", () => {
    expect(runEventsFromStreamEvent("claude", { type: "mystery" })).toEqual([]);
    expect(runEventsFromStreamEvent("codex", null)).toEqual([]);
  });
});

describe("agent capability defaults", () => {
  it("applies adapter defaults for live capabilities", () => {
    const claude = normalizeTool({
      id: "claude",
      adapter: "claude",
      command: "claude",
      usage: { kind: "usage-only" }
    });
    expect(claude.cli.midTurnInput).toBe(true);
    expect(claude.cli.streamOutput).toBe(true);

    const codex = normalizeTool({
      id: "codex",
      adapter: "codex",
      command: "codex",
      usage: { kind: "quota", period: "weekly", limit: 100 }
    });
    expect(codex.cli.streamOutput).toBe(true);
    expect(codex.cli.midTurnInput).toBe(false);

    const generic = normalizeTool({
      id: "custom",
      adapter: "generic",
      command: "custom",
      usage: { kind: "usage-only" }
    });
    expect(generic.cli.midTurnInput).toBe(false);
    expect(generic.cli.streamOutput).toBe(false);
  });

  it("respects an explicit capability override", () => {
    const tool = normalizeTool({
      id: "claudish",
      adapter: "claude",
      command: "claude",
      cli: { midTurnInput: false },
      usage: { kind: "usage-only" }
    });
    expect(tool.cli.midTurnInput).toBe(false);
    // Unspecified flags still fall back to adapter defaults.
    expect(tool.cli.streamOutput).toBe(true);
  });
});

import { chmod, writeFile } from "node:fs/promises";

import { buildLaunchArgs } from "../src/runners/adapter.ts";
import { HeadlessAgentRunner, streamJsonUserMessage } from "../src/runners/headless.ts";
import { isLiveRunner } from "../src/runners/types.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../src/core/agents/config/types.ts";
import type { HarnessTask } from "../src/core/types.ts";

function claudeTool(command: string, midTurnInput = true): AgentToolConfig {
  return {
    id: "claude",
    displayName: "Claude",
    command,
    adapter: "claude",
    enabled: true,
    builtin: false,
    supportsEffort: false,

    cli: { midTurnInput },
    usage: { kind: "usage-only" }
  };
}

function claudePool(): ModelPoolConfig {
  return {
    id: "claude-test",
    toolId: "claude",
    displayName: "Claude test",
    modelArgs: [],
    modelEnv: {},
    capabilities: [],

    tier: "paid",
    usage: { kind: "usage-only" },
    usageSource: "none",
    enabled: true,
    builtin: false
  };
}

describe("claude live launch args", () => {
  it("uses stream-json input and probed partial messages when live", () => {
    const spec = buildLaunchArgs(claudeTool("claude"), claudePool(), {
      mode: "execute",
      prompt: "hi",
      cwd: "/tmp",
      live: true
    }, { partialMessages: true, addDir: true });
    expect(spec.inputStreamJson).toBe(true);
    expect(spec.args.join(" ")).toContain("--input-format stream-json");
    expect(spec.args).toContain("--include-partial-messages");
  });

  it("omits optional claude flags when probes say they are unavailable", () => {
    const spec = buildLaunchArgs(claudeTool("claude"), claudePool(), {
      mode: "execute",
      prompt: "hi",
      cwd: "/tmp",
      live: true,
      allowedDirs: ["/extra"]
    }, { partialMessages: false, addDir: false });
    expect(spec.args).not.toContain("--include-partial-messages");
    expect(spec.args).not.toContain("--add-dir");
  });

  it("uses text input when not live", () => {
    const spec = buildLaunchArgs(claudeTool("claude"), claudePool(), {
      mode: "execute",
      prompt: "hi",
      cwd: "/tmp"
    });
    expect(spec.inputStreamJson).toBeUndefined();
    expect(spec.args.join(" ")).toContain("--input-format text");
    expect(spec.args).not.toContain("--include-partial-messages");
  });
});

describe("stream-json framing", () => {
  it("frames an operator message as a newline-terminated user message", () => {
    const framed = streamJsonUserMessage("hello");
    expect(framed.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(framed.trim()) as {
      type: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(parsed.type).toBe("user");
    expect(parsed.message.content[0]?.text).toBe("hello");
  });
});

describe("LiveAgentRunner capability", () => {
  it("reports a midTurnInput tool as a live runner", () => {
    const runner = new HeadlessAgentRunner("claude", { tool: claudeTool("claude", true), pool: claudePool() });
    expect(runner.supportsMidTurnInput).toBe(true);
    expect(isLiveRunner(runner)).toBe(true);
  });

  it("does not report a non-midTurnInput tool as live", () => {
    const runner = new HeadlessAgentRunner("claude", { tool: claudeTool("claude", false), pool: claudePool() });
    expect(runner.supportsMidTurnInput).toBe(false);
    expect(isLiveRunner(runner)).toBe(false);
  });

  it("ignores operator messages when no live turn is active", () => {
    const runner = new HeadlessAgentRunner("claude", { tool: claudeTool("claude", true), pool: claudePool() });
    expect(() => runner.sendOperatorMessage("noop")).not.toThrow();
  });
});

const FAKE_CLAUDE = `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let text = "";
    try { text = JSON.parse(line).message.content[0].text; } catch {}
    process.stdout.write(JSON.stringify({ type: "assistant", session_id: "fake-sess", message: { content: [{ type: "text", text: "got: " + text }] } }) + "\\n");
    if (text.includes("stop")) {
      process.stdout.write(JSON.stringify({ type: "result", session_id: "fake-sess", result: "final: " + text }) + "\\n");
      process.exit(0);
    }
  }
});
`;

describe("live runner bidirectional turn (fake agent)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-live-proc-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams events, accepts a mid-turn operator message, then finishes on result", async () => {
    const script = path.join(root, "fake-claude.mjs");
    await writeFile(script, FAKE_CLAUDE, "utf8");
    await chmod(script, 0o755);

    const runner = new HeadlessAgentRunner("claude", { tool: claudeTool(script, true), pool: claudePool() });
    const texts: string[] = [];
    const types: string[] = [];
    let sent = false;

    const result = await runner.runTurn({
      task: { targets: [] } as unknown as HarnessTask,
      prompt: "hello",
      cwd: root,
      turnNumber: 1,
      mode: "execute",
      live: true,
      onEvent: (event) => {
        types.push(event.type);
        if (event.text) texts.push(event.text);
        if (event.type === "text_delta" && event.text === "got: hello" && !sent) {
          sent = true;
          runner.sendOperatorMessage("please stop");
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.reply).toContain("final: please stop");
    expect(types).toContain("operator_message");
    expect(texts).toContain("got: hello");
    expect(texts).toContain("got: please stop");
  });
});

import {
  clearInflightTurn,
  deliverOperatorMessageToLiveTurn,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import type { AgentRunner, LiveAgentRunner } from "../src/runners/types.ts";

function fakeLiveRunner(accept: boolean): LiveAgentRunner & { received: string[] } {
  const received: string[] = [];
  return {
    agent: "claude",
    received,
    supportsMidTurnInput: true,
    runTurn: async () => ({ reply: "", exitCode: 0, command: "fake", rawLog: "" }),
    abort: () => {},
    sendOperatorMessage: (text: string) => {
      if (!accept) return false;
      received.push(text);
      return true;
    }
  };
}

function fakeBatchRunner(): AgentRunner {
  return {
    agent: "codex",
    runTurn: async () => ({ reply: "", exitCode: 0, command: "fake", rawLog: "" }),
    abort: () => {}
  };
}

describe("operator message routing to live turns", () => {
  afterEach(() => {
    for (const taskId of listInflightTaskIds()) clearInflightTurn(taskId);
  });

  it("delivers to a live runner that accepts mid-turn input", () => {
    const runner = fakeLiveRunner(true);
    registerInflightTurn("task-live", runner, "run-live");
    const result = deliverOperatorMessageToLiveTurn("task-live", "hello there");
    expect(result.delivered).toBe(true);
    expect(result.runId).toBe("run-live");
    expect(runner.received).toEqual(["hello there"]);
  });

  it("does not deliver when the live runner rejects input (falls back to a new turn)", () => {
    registerInflightTurn("task-busy", fakeLiveRunner(false), "run-busy");
    expect(deliverOperatorMessageToLiveTurn("task-busy", "hi").delivered).toBe(false);
  });

  it("does not deliver to a batch (non-live) runner", () => {
    registerInflightTurn("task-batch", fakeBatchRunner(), "run-batch");
    expect(deliverOperatorMessageToLiveTurn("task-batch", "hi").delivered).toBe(false);
  });

  it("does not deliver when no turn is inflight", () => {
    expect(deliverOperatorMessageToLiveTurn("task-none", "hi").delivered).toBe(false);
  });
});

describe("headless runner launch isolation", () => {
  it("does not grant the shared harness root as a writable Claude add-dir", async () => {
    const runner = new HeadlessAgentRunner("claude", {
      tool: claudeTool("/bin/echo"),
      pool: claudePool()
    });
    const task: HarnessTask = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Isolated launch",
      description: "Keep writes in the prepared worktree.",
      agent: "claude",
      source: "manual",
      links: [],
      targets: [{ raw: "@/repo", path: "/repo", kind: "directory" }],
      messages: [],
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    };

    const result = await runner.runTurn({
      task,
      prompt: "hello",
      cwd: "/isolated/worktree",
      harnessRoot: "/shared/harness",
      turnNumber: 1
    });

    expect(result.command).toContain("--add-dir /isolated/worktree");
    expect(result.command).not.toContain("--add-dir /shared/harness");
  });
});


function structuredTool(id: "codex" | "opencode"): AgentToolConfig {
  return {
    id,
    displayName: id,
    command: id,
    adapter: id,
    enabled: true,
    builtin: false,
    supportsEffort: false,

    cli: {},
    usage: { kind: "usage-only" }
  };
}

function poolFor(toolId: "codex" | "opencode"): ModelPoolConfig {
  return {
    id: `${toolId}-test`,
    toolId,
    displayName: toolId,
    modelArgs: [],
    modelEnv: {},
    capabilities: [],

    tier: "paid",
    usage: { kind: "usage-only" },
    usageSource: "none",
    enabled: true,
    builtin: false
  };
}

describe("structured-stream adapters (codex / opencode)", () => {
  it("codex preserves the sandbox flag and is not live", () => {
    const execute = buildLaunchArgs(structuredTool("codex"), poolFor("codex"), {
      mode: "execute",
      prompt: "do it",
      cwd: "/repo"
    });
    expect(execute.args).toContain("-s");
    expect(execute.args).toContain("workspace-write");
    expect(execute.args).not.toContain("-");
    expect(execute.inputStreamJson).toBeUndefined();

    const plan = buildLaunchArgs(structuredTool("codex"), poolFor("codex"), {
      mode: "plan",
      prompt: "think",
      cwd: "/repo"
    });
    expect(plan.args).toContain("read-only");
  });

  it("codex resumes a prior session", () => {
    const spec = buildLaunchArgs(structuredTool("codex"), poolFor("codex"), {
      mode: "execute",
      prompt: "more",
      cwd: "/repo",
      sessionId: "sess-9"
    });
    expect(spec.args.slice(0, 3)).toEqual(["exec", "resume", "sess-9"]);
  });

  it("opencode resumes a prior session", () => {
    const spec = buildLaunchArgs(structuredTool("opencode"), poolFor("opencode"), {
      mode: "execute",
      prompt: "more",
      cwd: "/repo",
      sessionId: "oc-7"
    });
    expect(spec.args.join(" ")).toContain("--session oc-7");
  });

  it("codex and opencode stream events but reject mid-turn input by capability", () => {
    const codex = normalizeTool({
      id: "codex",
      adapter: "codex",
      command: "codex",
      usage: { kind: "quota", period: "weekly", limit: 100 }
    });
    const opencode = normalizeTool({
      id: "opencode",
      adapter: "opencode",
      command: "opencode",
      usage: { kind: "quota", period: "monthly", limit: 100 }
    });
    for (const tool of [codex, opencode]) {
      expect(tool.cli.streamOutput).toBe(true);
      expect(tool.cli.streamTools).toBe(true);
      expect(tool.cli.sessionResume).toBe(true);
      expect(tool.cli.midTurnInput).toBe(false);
    }
  });
});


import { buildTranscript } from "../src/core/runs/transcript.ts";
import { capabilityTier, capabilityTierLabel } from "../src/core/agents/config/capabilities.ts";
import type { RunEvent } from "../src/core/runs/events.ts";

function ev(partial: Partial<RunEvent> & { type: RunEvent["type"] }, seq: number): RunEvent {
  return { seq, at: new Date(seq).toISOString(), ...partial };
}

describe("buildTranscript", () => {
  it("coalesces consecutive text and thinking deltas", () => {
    const events: RunEvent[] = [
      ev({ type: "thinking_delta", text: "hmm " }, 1),
      ev({ type: "thinking_delta", text: "ok" }, 2),
      ev({ type: "text_delta", text: "Hello " }, 3),
      ev({ type: "text_delta", text: "world" }, 4)
    ];
    const transcript = buildTranscript(events);
    expect(transcript).toEqual([
      { kind: "thinking", text: "hmm ok" },
      { kind: "text", text: "Hello world" }
    ]);
  });

  it("renders tool, operator, and terminal entries; drops non-visual events", () => {
    const events: RunEvent[] = [
      ev({ type: "session_id", sessionId: "s1" }, 1),
      ev({ type: "tool_call", tool: "Edit" }, 2),
      ev({ type: "operator_message", text: "keep going" }, 3),
      ev({ type: "text_delta", text: "done now" }, 4),
      ev({ type: "done", exitCode: 0 }, 5)
    ];
    const transcript = buildTranscript(events);
    expect(transcript.map((e) => e.kind)).toEqual(["tool", "operator", "text", "done"]);
    expect(transcript[0]).toMatchObject({ kind: "tool", tool: "Edit" });
    expect(transcript[3]).toMatchObject({ kind: "done", ok: true });
  });
});

describe("capabilityTier", () => {
  it("classifies live, stream, and batch agents", () => {
    expect(capabilityTier({ midTurnInput: true, streamOutput: true })).toBe("live");
    expect(capabilityTier({ midTurnInput: false, streamOutput: true })).toBe("stream");
    expect(capabilityTier({})).toBe("batch");
    expect(capabilityTierLabel("live")).toBe("Live chat");
    expect(capabilityTierLabel("stream")).toBe("Live stream");
    expect(capabilityTierLabel("batch")).toBe("Batch");
  });
});
