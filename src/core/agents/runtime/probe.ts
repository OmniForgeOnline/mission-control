import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentToolConfig } from "../config/types.ts";
import { buildLaunchEnv, resolveRuntimeCommand, type AgentRuntimeDiagnostic } from "./launch.ts";

const execFileAsync = promisify(execFile);
const probeCache = new Map<string, AgentRuntimeProbe>();

export interface AgentRuntimeProbe {
  available: boolean;
  command: string;
  version?: string | null;
  capabilities: Record<string, boolean>;
  diagnostics: AgentRuntimeDiagnostic[];
}

export async function probeAgentRuntime(tool: AgentToolConfig, input: { cwd: string }): Promise<AgentRuntimeProbe> {
  const cacheKey = `${tool.id}:${tool.command}:${input.cwd}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;

  const resolved = resolveRuntimeCommand(tool, input.cwd);
  if (!resolved.command) {
    const unavailable = {
      available: false,
      command: tool.command,
      capabilities: {},
      diagnostics: [{ code: "AGENT_COMMAND_NOT_FOUND", message: resolved.message ?? `Command not found: ${tool.command}` }]
    };
    probeCache.set(cacheKey, unavailable);
    return unavailable;
  }

  const env = buildLaunchEnv(resolved.command);
  const [version, capabilities] = await Promise.all([
    probeVersion(resolved.command, Array.isArray(tool.versionArgs) ? tool.versionArgs : [], input.cwd, env),
    probeCapabilities(
      resolved.command,
      Array.isArray(tool.helpArgs) ? tool.helpArgs : [],
      tool.capabilityFlags ?? {},
      input.cwd,
      env
    )
  ]);
  const result = {
    available: true,
    command: resolved.command,
    ...(version !== undefined ? { version } : {}),
    capabilities,
    diagnostics: []
  };
  probeCache.set(cacheKey, result);
  return result;
}

async function probeVersion(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string | null | undefined> {
  if (args.length === 0) return undefined;
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, env, timeout: 3000 });
    return String(stdout).trim().split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

async function probeCapabilities(
  command: string,
  args: string[],
  flags: Record<string, string>,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const key of Object.values(flags)) out[key] = false;
  if (args.length === 0 || Object.keys(flags).length === 0) return out;
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const text = String(stdout);
    for (const [flag, key] of Object.entries(flags)) out[key] = text.includes(flag);
  } catch {
    // Help probes are optional; use conservative capability defaults.
  }
  return out;
}
