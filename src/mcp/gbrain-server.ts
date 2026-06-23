/**
 * Stdio MCP server exposing the harness's gbrain memory + quality surface,
 * plus programmatic access to proposals, runs, kernel, skills, tasks, and the
 * tech-debt ledger.
 *
 * Wire format: line-delimited JSON-RPC 2.0 over stdin/stdout.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { callTool, TOOL_DEFS } from "./tool-registry.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.ts";

const rootCandidate = process.env["HARNESS_ROOT"] ?? process.argv[2];
const runId = process.env["HARNESS_RUN_ID"] ?? process.argv[3] ?? "ad-hoc";
const projectId = process.env["HARNESS_PROJECT_ID"] ?? process.argv[4];
if (!rootCandidate) {
  process.stderr.write("HARNESS_ROOT must be set or passed as the first argument\n");
  process.exit(1);
}
const root: string = rootCandidate;

const auditDir = path.join(root, "data", "state", "mcp-audit");
const auditFile = path.join(auditDir, `${runId}.jsonl`);

await ensureHarnessRepository(root);

async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(auditDir, { recursive: true });
    await appendFile(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* ignore audit failures */
  }
}

function send(message: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  if (req.method === "notifications/initialized") return null;
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gbrain", version: "1.1.0" }
      }
    };
  }
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } };
  }
  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    const args = params.arguments ?? {};
    await audit({ kind: "call", name, args });
    try {
      const result = await callTool({ root, runId, ...(projectId ? { projectId } : {}) }, name, args);
      await audit({ kind: "result", name, ok: true });
      return { jsonrpc: "2.0", id, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await audit({ kind: "error", name, error: message });
      return { jsonrpc: "2.0", id, error: { code: -32000, message } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
}

const rl = createInterface({ input: process.stdin });
let pending = 0;
let closed = false;

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pending += 1;
  try {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const response = await handle(req);
    if (response) send(response);
  } finally {
    pending -= 1;
    if (closed && pending === 0) process.exit(0);
  }
});
rl.on("close", () => {
  closed = true;
  if (pending === 0) process.exit(0);
});
