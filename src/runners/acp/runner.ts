import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveGbrainLauncher } from "../../mcp/launcher.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../../core/agents/config/types.ts";
import type { ToolId } from "../../core/types.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../types.ts";
import { AcpConnection, AcpResponseError } from "./client.ts";
import { runEventsFromAcpNotification, runEventsFromAcpUpdate } from "./events.ts";
import { resolveAgentLaunchPlan } from "../../core/agents/runtime/launch.ts";

type Json = Record<string, unknown>;

export interface AcpLaunchContext {
  tool: AgentToolConfig;
  pool: ModelPoolConfig;
}

/**
 * Runs the Kiro CLI (and any future ACP agent) over the Agent Client Protocol:
 * a newline-delimited JSON-RPC session on the CLI's stdio. Unlike the headless
 * runner, the agent drives client-bound requests (permissions, file IO) that we
 * service here. ACP has no in-prompt operator input, so this is a structured
 * stream runner (no LiveAgentRunner / mid-turn input).
 */
export class AcpAgentRunner implements AgentRunner {
  agent: ToolId;
  private readonly tool: AgentToolConfig;
  private readonly pool: ModelPoolConfig;
  private connection: AcpConnection | null = null;
  private sessionId: string | undefined;
  private aborted = false;

  constructor(agent: ToolId, launch: AcpLaunchContext) {
    this.agent = agent;
    this.tool = launch.tool;
    this.pool = launch.pool;
  }

  abort(): void {
    this.aborted = true;
    if (this.connection && this.sessionId) {
      this.connection.notify("session/cancel", { sessionId: this.sessionId });
    }
    this.connection?.close();
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.aborted = false;
    const planMode = request.mode === "plan";
    const args = ["acp", ...this.pool.modelArgs];
    const plan = await resolveAgentLaunchPlan(this.tool, this.pool, {
      cwd: request.cwd,
      args,
      env: this.pool.modelEnv
    });
    const fullCommand = [plan.command, ...args].join(" ");
    if (!plan.available) {
      const reason = plan.diagnostics[0]?.message ?? `Failed to resolve ${this.agent}`;
      return { reply: "", exitCode: 1, command: fullCommand, blockedReason: reason, rawLog: reason };
    }

    const child = spawn(plan.command, args, {
      cwd: request.cwd,
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const connection = new AcpConnection(child);
    this.connection = connection;

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    this.registerClientHandlers(connection, request.cwd, planMode);

    let reply = "";
    connection.onNotification((method, params) => {
      const events = method === "session/update"
        ? runEventsFromAcpUpdate((params as Json)["update"])
        : runEventsFromAcpNotification(method, params);
      for (const event of events) {
        request.onEvent?.(event);
        if (event.type === "text_delta" && event.text) {
          reply += event.text;
          request.onOutput?.(event.text);
        }
        if (event.type === "tool_call" && event.tool) {
          request.onActivity?.({ label: `using ${event.tool}`, at: new Date().toISOString() });
        }
      }
    });

    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
      });

      const sessionParams: Json = { cwd: request.cwd, mcpServers: gbrainMcpServers(request) };
      if (request.sessionId) {
        this.sessionId = request.sessionId;
        await connection.request("session/load", { ...sessionParams, sessionId: request.sessionId });
      } else {
        const created = (await connection.request("session/new", sessionParams)) as { sessionId?: string };
        this.sessionId = created?.sessionId;
      }
      if (this.sessionId) request.onSessionId?.(this.sessionId);

      const result = (await connection.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: request.prompt }]
      })) as { stopReason?: string };

      connection.close();
      return this.buildResult(reply, result?.stopReason, fullCommand, stderr);
    } catch (err) {
      connection.close();
      const reason = this.aborted ? "Stopped by operator" : formatAcpError(err);
      return {
        reply: reply.trim(),
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        exitCode: 1,
        command: fullCommand,
        blockedReason: reason,
        rawLog: stderr
      };
    } finally {
      this.connection = null;
    }
  }

  private buildResult(
    reply: string,
    stopReason: string | undefined,
    command: string,
    stderr: string
  ): AgentTurnResult {
    const ok = stopReason === "end_turn" && !this.aborted;
    const blockedReason = ok
      ? undefined
      : this.aborted
      ? "Stopped by operator"
      : `Kiro stopped: ${stopReason ?? "unknown"}`;
    return {
      reply: reply.trim(),
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      exitCode: ok ? 0 : 1,
      command,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
      rawLog: stderr ? `[stderr]\n${stderr}` : ""
    };
  }

  private registerClientHandlers(connection: AcpConnection, cwd: string, planMode: boolean): void {
    connection.setRequestHandler("session/request_permission", (params) => {
      // ACP semantics (schema v1): the `cancelled` outcome means the entire
      // prompt turn was cancelled, and a client MUST only send it in response
      // to its own session/cancel. Using it to *deny* a tool makes the agent
      // abandon the turn ("Tool uses were interrupted") and report `refusal`.
      // So denials must SELECT a reject option instead, which lets the agent
      // record the rejection and keep planning.
      if (this.aborted) return { outcome: { outcome: "cancelled" } };

      // Plan mode is read-only, not no-tools: scoping turns must still call the
      // harness read tools (read_skill, gbrain_read, ...) and inspect the repo.
      // Reject only mutating tools (edit/delete/move/execute); allow the rest.
      const decision = planMode && isMutatingToolCall(params) ? "reject" : "allow";
      const optionId = pickOption(params, decision);
      if (optionId) return { outcome: { outcome: "selected", optionId } };
      // No matching option offered. Falling back to `cancelled` would abort the
      // turn, so prefer any reject option, then any allow, before giving up.
      const fallback = pickOption(params, "reject") ?? pickOption(params, "allow");
      return fallback
        ? { outcome: { outcome: "selected", optionId: fallback } }
        : { outcome: { outcome: "cancelled" } };
    });

    connection.setRequestHandler("fs/read_text_file", async (params) => {
      const filePath = resolveWithin(cwd, params["path"]);
      const content = await readFile(filePath, "utf8");
      return { content };
    });

    connection.setRequestHandler("fs/write_text_file", async (params) => {
      if (planMode) throw new Error("Writes are not permitted in plan mode");
      const filePath = resolveWithin(cwd, params["path"]);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, String(params["content"] ?? ""), "utf8");
      return {};
    });
  }
}

function formatAcpError(err: unknown): string {
  if (err instanceof AcpResponseError) {
    const detail = typeof err.data === "string" ? err.data.trim() : "";
    if (detail && detail !== err.message) return `${err.message}: ${detail}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a file path and reject anything escaping the turn's working dir. */
function resolveWithin(cwd: string, rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("path is required");
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, rawPath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Path is outside the workspace: ${rawPath}`);
  }
  return resolved;
}

/** True for tool calls that change state and should be denied in plan mode. */
function isMutatingToolCall(params: Record<string, unknown>): boolean {
  const toolCall = params["toolCall"];
  if (!toolCall || typeof toolCall !== "object") return false;
  const kind = (toolCall as Record<string, unknown>)["kind"];
  if (typeof kind !== "string") return false;
  return MUTATING_KINDS.has(kind.toLowerCase());
}

const MUTATING_KINDS = new Set(["edit", "delete", "move", "execute"]);

/**
 * Select a permission option by intent. Prefers a one-time choice over a
 * persistent one so we never silently teach the agent to "always" do something.
 */
function pickOption(params: Record<string, unknown>, intent: "allow" | "reject"): string | undefined {
  const options = params["options"];
  if (!Array.isArray(options)) return undefined;
  const order = intent === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const match =
    order.map((kind) => options.find((opt) => hasOptionKind(opt, kind))).find(Boolean) ??
    options.find((opt) => hasOptionKind(opt, undefined, intent));
  if (match && typeof match === "object") {
    const id = (match as Record<string, unknown>)["optionId"];
    if (typeof id === "string") return id;
  }
  return undefined;
}

function hasOptionKind(option: unknown, kind?: string, prefix?: string): boolean {
  if (!option || typeof option !== "object") return false;
  const optionKind = (option as Record<string, unknown>)["kind"];
  if (typeof optionKind !== "string") return false;
  if (kind) return optionKind === kind;
  if (prefix) return optionKind.startsWith(prefix);
  return false;
}

/**
 * Build the ACP `mcpServers` entry for the harness gbrain server so Kiro turns
 * get the same memory/proposal tools as the other agents. Returns [] unless the
 * turn carries a harness root + run id (the gbrain server keys off both).
 */
function gbrainMcpServers(request: AgentTurnRequest): Json[] {
  if (!request.harnessRoot || !request.runId) return [];
  const { command, args } = resolveGbrainLauncher();
  const projectId = request.task.projectId;
  return [
    {
      name: "gbrain",
      command,
      args,
      env: [
        { name: "HARNESS_ROOT", value: request.harnessRoot },
        { name: "HARNESS_RUN_ID", value: request.runId },
        ...(projectId ? [{ name: "HARNESS_PROJECT_ID", value: projectId }] : [])
      ]
    }
  ];
}
