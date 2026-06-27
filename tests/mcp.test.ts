import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeQualityGrades } from "../src/core/quality/quality.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import { captureMemoryPage } from "../src/memory/store.ts";
import { buildMemoryIndex } from "../src/memory/index.ts";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  Object.defineProperty(execFileMock, promisify.custom, {
    value: (
      file: string,
      args: readonly string[] | null | undefined,
      options: object
    ) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          file,
          args ?? [],
          options,
          (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({
              stdout: typeof stdout === "string" ? stdout : stdout?.toString() ?? "",
              stderr: typeof stderr === "string" ? stderr : stderr?.toString() ?? ""
            });
          }
        );
      }),
    configurable: true
  });
  return {
    ...actual,
    execFile: execFileMock,
    spawn: actual.spawn
  };
});

vi.mock("../src/core/agents/resolver.ts", () => ({
  resolveCommandBinary: vi.fn(() => "/usr/local/bin/agent")
}));

function toolFor(adapter: "codex" | "claude" | "grok") {
  return builtinAgentConfigBundle().tools.find((tool) => tool.adapter === adapter)!;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseToolText(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text: string }> })?.content;
  const text = content?.[0]?.text;
  return text ? JSON.parse(text) : result;
}

function execCmdArgs(args: unknown[]): string[] {
  return args.find((arg): arg is string[] => Array.isArray(arg) && arg.includes("mcp")) ?? [];
}

async function mcpRequest(
  proc: ChildProcessWithoutNullStreams,
  request: Record<string, unknown>,
  timeoutMs = 8_000
): Promise<JsonRpcMessage> {
  const id = request['id'] ?? 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP request timed out")), timeoutMs);
    const rl = createInterface({ input: proc.stdout });
    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        if (msg.id === id) {
          clearTimeout(timer);
          rl.off("line", onLine);
          resolve(msg);
        }
      } catch {
        /* wait for a complete JSON-RPC line */
      }
    };
    rl.on("line", onLine);
    proc.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe.sequential("mcp launcher", () => {
  let harnessRoot: string;

  beforeEach(async () => {
    harnessRoot = await mkdtemp(path.join(tmpdir(), "harness-mcp-"));
    await ensureHarnessRepository(harnessRoot);
    execFileMock.mockReset();
  });

  afterEach(async () => {
    await rm(harnessRoot, { recursive: true, force: true });
  });

  it("resolveGbrainLauncher points at gbrain-server via tsx or node --import", async () => {
    const { resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();
    const serverArg = launch.args[launch.args.length - 1];

    expect(serverArg).toMatch(/gbrain-server\.(ts|js)$/);
    if (launch.command.includes("tsx")) {
      expect(launch.args).toHaveLength(1);
    } else {
      expect([process.execPath, launch.command]).toContain(launch.command);
    }
  });

  it("grokMcpArgFlags wraps node flags as --args=...", async () => {
    const { grokMcpArgFlags } = await import("../src/mcp/launcher.ts");
    expect(grokMcpArgFlags(["--import", "tsx", "/tmp/gbrain-server.ts"])).toEqual([
      "--args=--import",
      "--args",
      "tsx",
      "--args",
      "/tmp/gbrain-server.ts"
    ]);
  });

  it("grokMcpEntryMatchesHarness requires command, args, and HARNESS_ROOT alignment", async () => {
    const { grokMcpEntryMatchesHarness, resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();

    expect(
      grokMcpEntryMatchesHarness(
        { name: "gbrain", command: launch.command, args: launch.args, env: { HARNESS_ROOT: harnessRoot } },
        harnessRoot
      )
    ).toBe(true);

    expect(
      grokMcpEntryMatchesHarness(
        { name: "gbrain", command: launch.command, args: launch.args, env: { HARNESS_ROOT: "/other" } },
        harnessRoot
      )
    ).toBe(false);
  });

  it("writeMcpConfig emits codex TOML overrides and env", async () => {
    const { writeMcpConfig, resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();
    const result = await writeMcpConfig({
      tool: toolFor("codex"),
      harnessRoot,
      runId: "run-1",
      runDir: path.join(harnessRoot, "data", "runs", "run-1")
    });

    expect(result.env).toEqual({ HARNESS_ROOT: harnessRoot, HARNESS_RUN_ID: "run-1" });
    expect(result.cliArgs[0]).toBe("-c");
    expect(result.cliArgs[1]).toBe(`mcp_servers.gbrain.command=${JSON.stringify(launch.command)}`);
    expect(result.cliArgs[3]).toBe(
      `mcp_servers.gbrain.args=[${[...launch.args, harnessRoot, "run-1"].map((arg) => JSON.stringify(arg)).join(", ")}]`
    );
  });

  it("writeMcpConfig writes claude mcp-config.json under the run dir", async () => {
    const { writeMcpConfig, resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();
    const runDir = path.join(harnessRoot, "data", "runs", "run-claude");
    const result = await writeMcpConfig({
      tool: toolFor("claude"),
      harnessRoot,
      runId: "run-claude",
      runDir
    });

    const configPath = path.join(runDir, "mcp-config.json");
    expect(result.configPath).toBe(configPath);
    expect(result.cliArgs).toEqual(["--mcp-config", configPath]);
    expect(result.env).toEqual({ HARNESS_ROOT: harnessRoot, HARNESS_RUN_ID: "run-claude" });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.mcpServers.gbrain).toEqual({
      command: launch.command,
      args: launch.args,
      env: { HARNESS_ROOT: harnessRoot, HARNESS_RUN_ID: "run-claude" }
    });
  });

  it("writeMcpConfig for grok delegates to ensureGrokMcp and returns env only", async () => {
    const { writeMcpConfig, resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();

    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
      const cmdArgs = execCmdArgs(args);
      if (cmdArgs.includes("list")) {
        callback(
          null,
          JSON.stringify([
            {
              name: "gbrain",
              command: launch.command,
              args: launch.args,
              env: { HARNESS_ROOT: harnessRoot }
            }
          ]),
          ""
        );
        return;
      }
      callback(new Error("unexpected execFile call"), "", "");
    });

    const result = await writeMcpConfig({
      tool: toolFor("grok"),
      harnessRoot,
      runId: "run-grok",
      runDir: path.join(harnessRoot, "data", "runs", "run-grok")
    });

    expect(result.cliArgs).toEqual([]);
    expect(result.env).toEqual({ HARNESS_ROOT: harnessRoot, HARNESS_RUN_ID: "run-grok" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0]?.[1] as string[] | undefined) ?? []).toContain("list");
  });

  it("ensureGrokMcp skips mcp add when a matching gbrain entry exists", async () => {
    const { ensureGrokMcp, resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();

    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
      const cmdArgs = execCmdArgs(args);
      if (cmdArgs.includes("list")) {
        callback(
          null,
          JSON.stringify([
            {
              name: "gbrain",
              command: launch.command,
              args: launch.args,
              env: { HARNESS_ROOT: harnessRoot }
            }
          ]),
          ""
        );
        return;
      }
      callback(new Error("mcp add should not run"), "", "");
    });

    await ensureGrokMcp(harnessRoot, "agent");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execCmdArgs(execFileMock.mock.calls[0] ?? [])).toContain("list");
  });

  it("ensureGrokMcp calls mcp add when the gbrain entry is missing or mismatched", async () => {
    const { ensureGrokMcp, resolveGbrainLauncher, grokMcpArgFlags } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();
    const addCalls: string[][] = [];

    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
      const cmdArgs = execCmdArgs(args);
      if (cmdArgs.includes("list")) {
        callback(null, JSON.stringify([]), "");
        return;
      }
      if (cmdArgs.includes("add")) {
        addCalls.push(cmdArgs);
        callback(null, "", "");
        return;
      }
      callback(new Error(`unexpected execFile call: ${cmdArgs.join(" ")}`), "", "");
    });

    await ensureGrokMcp(harnessRoot, "agent");

    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toEqual([
      "mcp",
      "add",
      "gbrain",
      "--command",
      launch.command,
      ...grokMcpArgFlags(launch.args),
      "--env",
      `HARNESS_ROOT=${harnessRoot}`
    ]);
  });
});

describe("gbrain MCP server", () => {
  let harnessRoot: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    harnessRoot = await mkdtemp(path.join(tmpdir(), "harness-gbrain-server-"));
    await ensureHarnessRepository(harnessRoot);
  });

  afterEach(async () => {
    child?.kill("SIGTERM");
    child = undefined;
    await rm(harnessRoot, { recursive: true, force: true });
  });

  async function startServer(env: Record<string, string> = {}): Promise<ChildProcessWithoutNullStreams> {
    const { resolveGbrainLauncher } = await import("../src/mcp/launcher.ts");
    const launch = resolveGbrainLauncher();
    const proc = spawn(launch.command, launch.args, {
      cwd: path.resolve(path.dirname(launch.args[launch.args.length - 1] ?? ""), "../.."),
      env: {
        ...process.env,
        HARNESS_ROOT: harnessRoot,
        HARNESS_RUN_ID: "mcp-test-run",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child = proc;
    return proc;
  }

  it("initialize and tools/list expose the expected gbrain tools", async () => {
    const proc = await startServer();

    const init = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" }
      }
    });
    expect(init.error).toBeUndefined();
    expect((init.result as { serverInfo?: { name: string } })?.serverInfo?.name).toBe("gbrain");

    const listed = await mcpRequest(proc, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ((listed.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "gbrain_search",
        "gbrain_list",
        "quality_grades",
        "list_hooks",
        "propose_skill",
        "list_skills"
      ])
    );
  });

  it("quality_grades returns a domain payload", async () => {
    const qualityPath = path.join(harnessRoot, "data", "state", "quality.json");
    await writeFile(
      qualityPath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        domains: {
          mcp: {
            grade: "A",
            rationale: "Healthy: no oversized files, tests reference this domain.",
            evidence: ["src/mcp"],
            lastComputedAt: new Date().toISOString()
          }
        }
      }),
      "utf8"
    );

    const proc = await startServer();
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const response = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "quality_grades", arguments: { domain: "mcp" } }
    });

    expect(response.error).toBeUndefined();
    const payload = parseToolText(response.result) as Record<string, unknown>;
    expect(payload).toHaveProperty("mcp");
  });

  it("list_hooks returns an empty array when hooks.yml is absent", async () => {
    const proc = await startServer();
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const response = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_hooks", arguments: {} }
    });

    expect(response.error).toBeUndefined();
    expect(parseToolText(response.result)).toEqual([]);
  });

  it("gbrain_list returns an empty array on an empty memory store", async () => {
    const proc = await startServer();
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const response = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gbrain_list", arguments: {} }
    });

    expect(response.error).toBeUndefined();
    expect(parseToolText(response.result)).toEqual([]);
  });

  it("gbrain_search is limited to the configured project memory scope", async () => {
    await captureMemoryPage(harnessRoot, "proj-gateway", {
      slug: "overview",
      type: "project",
      title: "Gateway",
      tags: ["auth"],
      content: "Gateway uses opaque refresh token rotation."
    });
    await captureMemoryPage(harnessRoot, "proj-dashboard", {
      slug: "overview",
      type: "project",
      title: "Dashboard",
      tags: ["auth"],
      content: "Dashboard uses opaque refresh token rotation."
    });

    const proc = await startServer({ HARNESS_PROJECT_ID: "proj-gateway" });
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const response = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gbrain_search", arguments: { query: "opaque refresh token rotation" } }
    });

    expect(response.error).toBeUndefined();
    const payload = parseToolText(response.result) as Array<{ title: string }>;
    expect(payload.map((hit) => hit.title)).toContain("Gateway");
    expect(payload.map((hit) => hit.title)).not.toContain("Dashboard");
  });

  it("gbrain_index_search does not return indexed memory from another project scope", async () => {
    await captureMemoryPage(harnessRoot, "proj-gateway", {
      slug: "overview",
      type: "project",
      title: "Gateway",
      tags: ["auth"],
      content: "Gateway uses qzxw refresh token rotation."
    });
    await captureMemoryPage(harnessRoot, "proj-dashboard", {
      slug: "overview",
      type: "project",
      title: "Dashboard",
      tags: ["auth"],
      content: "Dashboard uses qzxw refresh token rotation."
    });
    await buildMemoryIndex(harnessRoot, "proj-gateway");

    const proc = await startServer({ HARNESS_PROJECT_ID: "proj-gateway" });
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const response = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gbrain_index_search", arguments: { query: "qzxw refresh token rotation" } }
    });

    expect(response.error).toBeUndefined();
    const payload = parseToolText(response.result) as Array<{ id: string }>;
    expect(payload.map((hit) => hit.id)).toContain("memory:overview");
    expect(payload.every((hit) => hit.id === "memory:overview")).toBe(true);
  });

  it("returns JSON-RPC errors for unknown tools and invalid propose_skill names", async () => {
    const proc = await startServer();
    await mcpRequest(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const unknown = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "definitely_not_a_tool", arguments: {} }
    });
    expect(unknown.error?.message).toContain("Unknown tool");

    const invalidSkill = await mcpRequest(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "propose_skill",
        arguments: {
          name: "Bad Name!",
          description: "bad",
          body: "bad",
          rationale: "bad"
        }
      }
    });
    expect(invalidSkill.error?.message).toContain("lowercase-dash");
  });
});

describe("mcp quality grade", () => {
  it("assigns grade A once tests/mcp.test.ts exists in the harness repo", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    expect(existsSync(path.join(repoRoot, "tests", "mcp.test.ts"))).toBe(true);

    const quality = await computeQualityGrades(repoRoot);
    expect(quality.domains['mcp']?.grade).toBe("A");
    expect(quality.domains['mcp']?.rationale).toContain("tests reference this domain");
  });
});
