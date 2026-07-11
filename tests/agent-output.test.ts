import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const fixturePath = (...parts: string[]) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", ...parts);

import {
  extractSessionIdFromStreamEvent,
  healStreamedMarkdown,
  normalizeEscapedNewlines,
  parseAgentOutput,
  parseAgentStreamOutput,
  parseGrokStreamingOutput,
  prepareTextForMarkdown,
  sanitizeAgentMessageBody
} from "../src/core/agents/output.ts";
import { processAgentStreamLine } from "../src/runners/headless.ts";

describe("agent output normalization", () => {
  it("normalizes literal \\n sequences from leaked JSON plan text", () => {
    const raw = "\\n# Plan\\n\\nStep one\\n- item";
    expect(normalizeEscapedNewlines(raw)).toBe("\n# Plan\n\nStep one\n- item");
  });

  it("parses codex NDJSON streams into assistant text", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Hello operator" }
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "What should I do next?" }
      })
    ].join("\n");

    expect(parseAgentStreamOutput(stdout)).toBe("Hello operator\n\nWhat should I do next?");
  });

  it("keeps every codex assistant message in parseAgentOutput (no truncation to the last)", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-2" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Here are the tool questions." }
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "And the model pool questions." }
      })
    ].join("\n");

    expect(parseAgentOutput(stdout, "codex")).toEqual({
      reply: "Here are the tool questions.\n\nAnd the model pool questions.",
      sessionId: "thread-2"
    });
  });

  it("extracts codex thread_id from thread.started events", () => {
    const event = { type: "thread.started", thread_id: "thread-abc-123" };
    expect(extractSessionIdFromStreamEvent(event)).toBe("thread-abc-123");
  });

  it("extracts claude session_id from stream events", () => {
    const event = { type: "assistant", session_id: "claude-sess-9", message: { content: [] } };
    expect(extractSessionIdFromStreamEvent(event)).toBe("claude-sess-9");
  });

  it("does not treat claude system init protocol events as step conversation text", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: "/home/user/harness/data/state/worktrees/946cca947769",
        session_id: "31414f5c-c37d-4dd2-a2da-7eb855821f23",
        tools: ["Task", "AskUserQuestion", "Bash", "Edit"]
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "31414f5c-c37d-4dd2-a2da-7eb855821f23",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "npm run test" }
            }
          ]
        }
      })
    ].join("\n");

    expect(parseAgentOutput(stdout, "claude")).toEqual({
      reply: "",
      sessionId: "31414f5c-c37d-4dd2-a2da-7eb855821f23"
    });
    expect(sanitizeAgentMessageBody(stdout)).toBe("");
  });

  it("fires onSessionId while processing streamed NDJSON lines", () => {
    const seen: string[] = [];
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-live-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Hello" }
      })
    ];

    for (const line of lines) {
      processAgentStreamLine(line, "codex", {
        onSessionId: (id) => seen.push(id)
      });
    }

    expect(seen).toEqual(["thread-live-1"]);
  });

  it("parses grok streaming-json thought/text chunks into readable text", () => {
    const stdout = [
      JSON.stringify({ type: "thought", data: "The" }),
      JSON.stringify({ type: "thought", data: " user" }),
      JSON.stringify({ type: "text", data: "Planning " }),
      JSON.stringify({ type: "text", data: "scope discovery." }),
      JSON.stringify({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "grok-sess-stream-1"
      })
    ].join("\n");

    expect(parseGrokStreamingOutput(stdout)).toEqual({
      reply: "Planning scope discovery.",
      sessionId: "grok-sess-stream-1"
    });
    expect(parseAgentOutput(stdout, "grok")).toEqual({
      reply: "Planning scope discovery.",
      sessionId: "grok-sess-stream-1"
    });
    expect(parseAgentStreamOutput(stdout)).toBe("Planning scope discovery.");
  });

  it("parses grok streaming-json errors without leaking raw NDJSON", () => {
    const stdout = JSON.stringify({
      type: "error",
      message: "Internal error: Model does not support parameter reasoningEffort."
    });

    expect(parseGrokStreamingOutput(stdout).reply).toBe(
      "Internal error: Model does not support parameter reasoningEffort."
    );
    expect(sanitizeAgentMessageBody(stdout)).toBe(
      "Internal error: Model does not support parameter reasoningEffort."
    );
  });

  it("sanitizes stored planning turn messages that still contain raw JSON", () => {
    const rawBody = [
      "### Planning turn 1",
      "",
      '{"type":"thread.started","thread_id":"thread-plan-1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"\\\\n# Core Quality Gate Test Coverage Plan\\\\n\\\\nAdd tests for src/core."}}'
    ].join("\n");

    const cleaned = sanitizeAgentMessageBody(rawBody);
    expect(cleaned).toContain("### Planning turn 1");
    expect(cleaned).toContain("# Core Quality Gate Test Coverage Plan");
    expect(cleaned).not.toContain('{"type":"thread.started"');
    expect(cleaned).not.toContain("\\n# Core");
  });

  it("recovers grok text chunks when JSON data spans multiple physical lines", () => {
    const stdout = [
      '{"type":"text","data":"apply"}',
      '{"type":"text","data":"<"}',
      '{"type":"text","data":"pro"}',
      '{"type":"text","data":"posed"}',
      '{"type":"text","data":"_plan"}',
      '{"type":"text","data":">',
      '"}',
      '{"type":"text","data":"#"}',
      '{"type":"text","data":" Plan"}',
      JSON.stringify({ type: "end", sessionId: "sess-broken-json-1" })
    ].join("\n");

    expect(parseGrokStreamingOutput(stdout).reply).toContain("<proposed_plan>\n# Plan");
  });

  it("heals streamed markdown and renders headings from a real grok planning run", () => {
    const raw = readFileSync(fixturePath("grok-quality-gate-planning-stream.txt"), "utf8");
    const prepared = prepareTextForMarkdown(`### Planning turn 1\n\n${parseGrokStreamingOutput(raw).reply}`);

    expect(prepared).toContain("# Quality Gate");
    expect(prepared).toContain("## Problem");
    expect(prepared).toContain("## Success Criteria");
    expect(prepared).not.toMatch(/<proposed_plan#/i);
    expect(prepared).not.toContain("testsChecking");

    const html = marked.parse(prepared) as string;
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toContain("<li");
    expect(html).toContain("<li");
  });

  it("heals glued sentences and markdown headings", () => {
    const raw = "testsChecking how quality works## ProblemNo tests exist- Add tests";
    const healed = healStreamedMarkdown(raw);
    expect(healed).toContain("tests Checking");
    expect(healed).toContain("## Problem\n\nNo");
    expect(healed).toContain("\n- Add tests");
  });

  it("sanitizes stored grok planning turn messages that still contain raw JSON", () => {
    const rawBody = [
      "### Planning turn 1",
      "",
      JSON.stringify({ type: "thought", data: "Investigating quality gate." }),
      JSON.stringify({ type: "text", data: "Planning scope discovery for the core quality gate." }),
      JSON.stringify({ type: "text", data: "\n\n<proposed_plan>\n# Core plan\n</proposed_plan>" }),
      JSON.stringify({ type: "end", sessionId: "sess-plan-2" })
    ].join("\n");

    const cleaned = sanitizeAgentMessageBody(rawBody);
    expect(cleaned).toContain("### Planning turn 1");
    expect(cleaned).toContain("Planning scope discovery for the core quality gate.");
    expect(cleaned).toContain("<proposed_plan>");
    expect(cleaned).not.toContain('{"type":"thought"');
    expect(cleaned).not.toContain('{"type":"text"');
  });

  it("extracts codex turn.failed error message as errorReason", () => {
    const stdout = JSON.stringify({
      type: "turn.failed",
      error: { message: "You've hit your usage limit. Try again later." }
    });
    expect(parseAgentOutput(stdout, "codex").errorReason).toBe(
      "You've hit your usage limit. Try again later."
    );
  });

  it("falls back to a top-level codex type:error when no turn.failed is present", () => {
    const stdout = JSON.stringify({ type: "error", message: "request rejected upstream" });
    expect(parseAgentOutput(stdout, "codex").errorReason).toBe("request rejected upstream");
  });

  it("unwraps a double-encoded JSON error message to its inner message", () => {
    const inner = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "The 'gpt-5.6-sol' model requires a newer version of Codex."
      }
    });
    const stdout = JSON.stringify({ type: "turn.failed", error: { message: inner } });
    expect(parseAgentOutput(stdout, "codex").errorReason).toBe(
      "The 'gpt-5.6-sol' model requires a newer version of Codex."
    );
  });

  it("does not treat benign codex item.completed warnings as the failure reason", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-warn" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "Under-development features enabled." }
      }),
      JSON.stringify({ type: "turn.started" })
    ].join("\n");
    expect(parseAgentOutput(stdout, "codex").errorReason).toBeUndefined();
  });

  it("surfaces the real reason from a captured codex usage-limit run", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019f4c16-d1f6-7a41-a75c-4ed1cfcbcb03" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "Under-development features enabled." }
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "error",
        message:
          "You've hit your usage limit. Upgrade to Pro, visit settings/usage to purchase more credits or try again at 3:52 PM."
      }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "You've hit your usage limit. Upgrade to Pro, visit settings/usage to purchase more credits or try again at 3:52 PM."
        }
      })
    ].join("\n");
    expect(parseAgentOutput(stdout, "codex").errorReason).toContain("You've hit your usage limit");
  });

  it("surfaces the real reason from a captured codex unsupported-model run", () => {
    const inner = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
      }
    });
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019f4b92-6edd-7870-8f97-a1262616ffed" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "Under-development features enabled." }
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "error",
          message: "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata."
        }
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: inner }),
      JSON.stringify({ type: "turn.failed", error: { message: inner } })
    ].join("\n");
    expect(parseAgentOutput(stdout, "codex").errorReason).toBe(
      "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
    );
  });

  it("extracts grok type:error as errorReason", () => {
    const stdout = JSON.stringify({
      type: "error",
      message: "Model grok-composer-2.5-fast does not support parameter reasoningEffort."
    });
    expect(parseAgentOutput(stdout, "grok").errorReason).toBe(
      "Model grok-composer-2.5-fast does not support parameter reasoningEffort."
    );
  });
});
