import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runEventsFromAcpUpdate } from "../src/runners/acp/events.ts";
import { AcpAgentRunner } from "../src/runners/acp/runner.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../src/core/agents/config/types.ts";
import type { HarnessTask } from "../src/core/types.ts";

describe("runEventsFromAcpUpdate", () => {
  it("maps message, thought, tool_call and tool_call_update", () => {
    expect(runEventsFromAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toEqual([
      { type: "text_delta", text: "hi" }
    ]);
    expect(runEventsFromAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })).toEqual([
      { type: "thinking_delta", text: "hmm" }
    ]);
    const toolCall = runEventsFromAcpUpdate({ sessionUpdate: "tool_call", title: "Edit", rawInput: { file: "x" } });
    expect(toolCall[0]).toMatchObject({ type: "tool_call", tool: "Edit" });
    const toolUpdate = runEventsFromAcpUpdate({ sessionUpdate: "tool_call_update", title: "Edit", status: "completed" });
    expect(toolUpdate[0]).toMatchObject({ type: "tool_result", tool: "Edit" });
  });

  it("ignores unknown updates", () => {
    expect(runEventsFromAcpUpdate({ sessionUpdate: "available_commands_update" })).toEqual([]);
    expect(runEventsFromAcpUpdate(null)).toEqual([]);
  });
});

const FAKE_ACP_SERVER = `#!/usr/bin/env node
let buf = "";
let rid = 1000;
let resumed = false;
let mcpNames = [];
const pending = new Map();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const clientRequest = (method, params) => new Promise((resolve) => { const id = rid++; pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && msg.method === undefined) {
      const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (msg.method === "session/new") {
      mcpNames = (msg.params.mcpServers || []).map((s) => s.name);
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } });
    } else if (msg.method === "session/load") {
      resumed = true;
      mcpNames = (msg.params.mcpServers || []).map((s) => s.name);
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.method === "session/cancel") {
      process.exit(0);
    } else if (msg.method === "session/prompt") {
      const sid = msg.params.sessionId || "fake-session";
      const text = (msg.params.prompt && msg.params.prompt[0] && msg.params.prompt[0].text) || "";
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: resumed ? "resumed:Hello " : "Hello " } });
      if (text.includes("MCP")) {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mcp:" + mcpNames.join(",") + " " } });
      }
      update(sid, { sessionUpdate: "tool_call", title: "Edit", kind: "edit" });
      if (text.includes("HANG")) { return; } // never finish; test will abort
      const fsResp = await clientRequest("fs/write_text_file", { path: "../../etc/evil.txt", content: "x" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: fsResp.error ? "fs-rejected " : "fs-ok " } });
      let permKind = "edit"; let permTitle = "Edit";
      if (text.includes("READTOOL")) { permKind = "read"; permTitle = "Read"; }
      if (text.includes("GENERICKIND")) { permKind = "other"; permTitle = "gbrain_read"; }
      const perm = await clientRequest("session/request_permission", { toolCall: { kind: permKind, title: permTitle }, options: [{ optionId: "allow-1", kind: "allow_once" }, { optionId: "deny-1", kind: "reject_once" }] });
      const out = perm.result && perm.result.outcome;
      let decision = "cancelled";
      if (out && out.outcome === "selected") decision = out.optionId === "deny-1" ? "denied" : "approved";
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: decision + " " } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

function kiroTool(command: string): AgentToolConfig {
  return {
    id: "kiro",
    displayName: "Kiro",
    command,
    adapter: "acp",
    enabled: true,
    builtin: false,
    supportsEffort: false,
    effortLevels: [],
    cli: {},
    usage: { kind: "usage-only" }
  };
}

function kiroPool(): ModelPoolConfig {
  return {
    id: "kiro-test",
    toolId: "kiro",
    displayName: "Kiro",
    modelArgs: [],
    modelEnv: {},
    capabilities: [],
    qualityWeight: 50,
    tier: "paid",
    usage: { kind: "usage-only" },
    usageSource: "none",
    enabled: true,
    builtin: false
  };
}

describe("AcpAgentRunner (fake ACP server)", () => {
  let root: string;
  let script: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-acp-"));
    script = path.join(root, "fake-acp.mjs");
    await writeFile(script, FAKE_ACP_SERVER, "utf8");
    await chmod(script, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function request(extra: Partial<Parameters<AcpAgentRunner["runTurn"]>[0]>) {
    return {
      task: { targets: [] } as unknown as HarnessTask,
      prompt: "do it",
      cwd: root,
      turnNumber: 1,
      mode: "execute" as const,
      ...extra
    };
  }

  it("runs a full turn: streams events, auto-approves permission, rejects out-of-cwd writes", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const events: string[] = [];
    const result = await runner.runTurn(request({ onEvent: (e) => events.push(e.type) }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("fake-session");
    expect(result.reply).toContain("Hello");
    expect(result.reply).toContain("fs-rejected"); // write outside cwd was denied
    expect(result.reply).toContain("approved"); // permission auto-approved in execute mode
    expect(events).toContain("tool_call");
    expect(events).toContain("text_delta");
  });

  it("resumes a prior session via session/load", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ sessionId: "fake-session" }));
    expect(result.reply.startsWith("resumed:")).toBe(true);
  });

  it("cancels an in-flight turn on abort", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    let aborted = false;
    const result = await runner.runTurn(
      request({
        prompt: "HANG please",
        onEvent: () => {
          if (!aborted) {
            aborted = true;
            runner.abort();
          }
        }
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.blockedReason).toContain("Stopped by operator");
  });

  it("rejects mutating tools via a reject option (not cancel) and keeps the turn alive in plan mode", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ mode: "plan" }));
    expect(result.exitCode).toBe(0); // denial must NOT cancel/refuse the turn
    expect(result.reply).toContain("fs-rejected");
    expect(result.reply).toContain("denied"); // selected the reject option
    expect(result.reply).not.toContain("cancelled");
  });

  it("approves read-only tools in plan mode (by kind)", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ mode: "plan", prompt: "READTOOL please" }));
    expect(result.reply).toContain("approved");
    expect(result.reply).toContain("fs-rejected"); // writes still blocked in plan mode
  });

  it("approves non-mutating tools with a generic kind in plan mode", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ mode: "plan", prompt: "GENERICKIND please" }));
    expect(result.reply).toContain("approved");
  });

  it("registers the gbrain MCP server when the turn carries harness root + run id", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ prompt: "MCP check", harnessRoot: root, runId: "run-1" }));
    expect(result.reply).toContain("mcp:gbrain");
  });

  it("omits MCP servers when harness context is absent", async () => {
    const runner = new AcpAgentRunner("kiro", { tool: kiroTool(script), pool: kiroPool() });
    const result = await runner.runTurn(request({ prompt: "MCP check" }));
    expect(result.reply).toContain("mcp:"); // echoed, but empty list
    expect(result.reply).not.toContain("mcp:gbrain");
  });
});
