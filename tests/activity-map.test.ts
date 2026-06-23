import { describeAgentEvent } from "../src/runners/activity-map.ts";

describe("describeAgentEvent — claude stream-json", () => {
  it("labels a file edit by basename", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/ui/styles.css" } }]
      }
    };
    expect(describeAgentEvent("claude", event)).toBe("editing styles.css");
  });

  it("labels a test run from a Bash command", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run test" } }]
      }
    };
    expect(describeAgentEvent("claude", event)).toBe("running tests");
  });

  it("labels a git command with its subcommand", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "git push -u origin feat" } }]
      }
    };
    expect(describeAgentEvent("claude", event)).toBe("git push");
  });

  it("labels plain assistant text as writing a response", () => {
    const event = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] }
    };
    expect(describeAgentEvent("claude", event)).toBe("writing a response");
  });

  it("returns null for the terminal result event", () => {
    expect(describeAgentEvent("claude", { type: "result", result: "done", session_id: "x" })).toBeNull();
  });

  it("maps gbrain MCP tools to a readable name", () => {
    const event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "mcp__gbrain__search", input: {} }]
      }
    };
    expect(describeAgentEvent("claude", event)).toBe("calling gbrain search");
  });
});

describe("describeAgentEvent — codex --json", () => {
  it("labels an exec command begin", () => {
    const event = { msg: { type: "exec_command_begin", command: ["pytest", "-q"] } };
    expect(describeAgentEvent("codex", event)).toBe("running tests");
  });

  it("labels a patch apply by basename", () => {
    const event = { msg: { type: "patch_apply_begin", changes: [{ path: "src/core/tasks/tasks.ts" }] } };
    expect(describeAgentEvent("codex", event)).toBe("editing tasks.ts");
  });

  it("labels reasoning as thinking", () => {
    expect(describeAgentEvent("codex", { msg: { type: "agent_reasoning" } })).toBe("thinking");
  });

  it("returns null for unknown events", () => {
    expect(describeAgentEvent("codex", { msg: { type: "token_count", total: 42 } })).toBeNull();
  });
});
