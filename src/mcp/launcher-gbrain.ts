import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCommandBinary } from "../core/agents/resolver.ts";
import { ensureDir } from "../core/infra/fs.ts";
import type { AgentToolConfig } from "../core/agents/config/types.ts";
import type { McpLaunch, McpConfigArgs } from "./launcher-types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const exec = promisify(execFile);

export function resolveGbrainLauncher(): McpLaunch {
  const distServer = path.resolve(here, "gbrain-server.js");
  if (here.includes(`${path.sep}dist${path.sep}`) && existsSync(distServer)) {
    return { command: process.execPath, args: [distServer] };
  }
  const tsServer = path.resolve(here, "gbrain-server.ts");
  const tsxBin = path.join(packageRoot, "node_modules", ".bin", "tsx");
  if (existsSync(tsxBin)) {
    return { command: tsxBin, args: [tsServer] };
  }
  return { command: process.execPath, args: ["--import", "tsx", tsServer] };
}

interface GrokMcpEntry {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export function grokMcpEntryMatchesHarness(entry: GrokMcpEntry, harnessRoot: string): boolean {
  return launcherMatches(entry, resolveGbrainLauncher(), harnessRoot);
}

export function grokMcpArgFlags(args: string[]): string[] {
  return args.flatMap((arg) => (arg.startsWith("-") ? [`--args=${arg}`] : ["--args", arg]));
}

function launcherMatches(entry: GrokMcpEntry, launch: McpLaunch, harnessRoot: string): boolean {
  if (entry.command !== launch.command) return false;
  const entryArgs = entry.args ?? [];
  if (entryArgs.length !== launch.args.length) return false;
  for (let i = 0; i < launch.args.length; i++) {
    if (entryArgs[i] !== launch.args[i]) return false;
  }
  return entry.env?.["HARNESS_ROOT"] === harnessRoot;
}

/**
 * Grok MCP registration mutates the agent's global MCP registry via `mcp add`.
 * Phase 4 should migrate to per-launch/worktree-scoped config before extension scoping.
 */
export async function ensureGrokMcp(harnessRoot: string, command: string): Promise<void> {
  const launch = resolveGbrainLauncher();
  const agentCommand = resolveCommandBinary(command, harnessRoot);
  let existing: GrokMcpEntry[] = [];
  try {
    const { stdout } = await exec(agentCommand, ["mcp", "list", "--json"], {
      cwd: harnessRoot,
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      existing = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers)) {
      existing = (parsed as { servers: GrokMcpEntry[] }).servers;
    } else if (parsed && typeof parsed === "object") {
      existing = Object.entries(parsed as Record<string, GrokMcpEntry>).map(([name, entry]) => ({
        name,
        ...entry
      }));
    }
  } catch {
    existing = [];
  }

  const current = existing.find((entry) => entry.name === "gbrain");
  if (current && launcherMatches(current, launch, harnessRoot)) {
    return;
  }

  const addArgs = [
    "mcp",
    "add",
    "gbrain",
    "--command",
    launch.command,
    ...grokMcpArgFlags(launch.args),
    "--env",
    `HARNESS_ROOT=${harnessRoot}`
  ];
  await exec(agentCommand, addArgs, { cwd: harnessRoot, timeout: 15_000, maxBuffer: 1024 * 1024 });
}

export async function writeGbrainMcpConfig(opts: {
  tool: AgentToolConfig;
  harnessRoot: string;
  runId: string;
  runDir: string;
  projectId?: string;
}): Promise<McpConfigArgs> {
  const { command, args } = resolveGbrainLauncher();
  const envOverrides: Record<string, string> = {
    HARNESS_ROOT: opts.harnessRoot,
    HARNESS_RUN_ID: opts.runId
  };
  if (opts.projectId) {
    envOverrides["HARNESS_PROJECT_ID"] = opts.projectId;
  }

  if (opts.tool.adapter === "grok") {
    await ensureGrokMcp(opts.harnessRoot, opts.tool.command);
    return { cliArgs: [], env: envOverrides };
  }

  if (opts.tool.adapter === "claude") {
    await ensureDir(opts.runDir);
    const config = {
      mcpServers: {
        gbrain: {
          command,
          args,
          env: envOverrides
        }
      }
    };
    const configPath = path.join(opts.runDir, "mcp-config.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    return {
      cliArgs: ["--mcp-config", configPath],
      env: envOverrides,
      configPath
    };
  }

  if (opts.tool.adapter === "opencode") {
    await ensureDir(opts.runDir);
    const config = {
      mcp: {
        gbrain: {
          type: "local",
          command: [command, ...args],
          environment: envOverrides,
          enabled: true
        }
      }
    };
    const configPath = path.join(opts.runDir, "opencode-mcp.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    return {
      cliArgs: [],
      env: { ...envOverrides, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      configPath
    };
  }

  const mcpArgs = [...args, opts.harnessRoot, opts.runId, ...(opts.projectId ? [opts.projectId] : [])];
  const cliArgs = [
    "-c",
    `mcp_servers.gbrain.command=${JSON.stringify(command)}`,
    "-c",
    `mcp_servers.gbrain.args=[${mcpArgs.map((a) => JSON.stringify(a)).join(", ")}]`
  ];
  return { cliArgs, env: envOverrides };
}
