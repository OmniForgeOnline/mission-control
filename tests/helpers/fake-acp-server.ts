import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentToolConfig, ModelPoolConfig } from "../../src/core/agents/config/types.ts";

/** Minimal fake ACP server for plan-mode permission and fs/write tests. */
export const FAKE_ACP_SERVER = `#!/usr/bin/env node
let buf = "";
let rid = 1000;
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
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } });
    } else if (msg.method === "session/prompt") {
      const sid = msg.params.sessionId || "fake-session";
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
      update(sid, { sessionUpdate: "tool_call", title: "Edit", kind: "edit" });
      const fsResp = await clientRequest("fs/write_text_file", { path: "evil.txt", content: "x" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: fsResp.error ? "fs-rejected " : "fs-ok " } });
      const perm = await clientRequest("session/request_permission", { toolCall: { kind: "edit", title: "Edit" }, options: [{ optionId: "allow-1", kind: "allow_once" }, { optionId: "deny-1", kind: "reject_once" }] });
      const out = perm.result && perm.result.outcome;
      let decision = "cancelled";
      if (out && out.outcome === "selected") decision = out.optionId === "deny-1" ? "denied" : "approved";
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: decision + " " } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

export function kiroTool(command: string): AgentToolConfig {
  return {
    id: "kiro",
    displayName: "Kiro",
    command,
    adapter: "acp",
    enabled: true,
    builtin: false,
    supportsEffort: false,

    cli: {},
    usage: { kind: "usage-only" }
  };
}

export function kiroPool(): ModelPoolConfig {
  return {
    id: "kiro-test",
    toolId: "kiro",
    displayName: "Kiro",
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

export async function installFakeAcpServer(root: string): Promise<string> {
  const script = path.join(root, "fake-acp.mjs");
  await writeFile(script, FAKE_ACP_SERVER, "utf8");
  await chmod(script, 0o755);
  return script;
}
