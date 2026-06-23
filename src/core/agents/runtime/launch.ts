import path from "node:path";

import type { AgentToolConfig, ModelPoolConfig } from "../config/types.ts";
import { resolveCommandBinary } from "../resolver.ts";

export interface AgentRuntimeDiagnostic {
  code: string;
  message: string;
}

export interface AgentLaunchPlan {
  available: boolean;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  diagnostics: AgentRuntimeDiagnostic[];
}

export interface AgentLaunchInput {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export async function resolveAgentLaunchPlan(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  input: AgentLaunchInput
): Promise<AgentLaunchPlan> {
  const resolved = resolveRuntimeCommand(tool, input.cwd);
  const command = resolved.command ?? tool.command;
  return {
    available: resolved.command !== null,
    command,
    args: input.args,
    env: buildLaunchEnv(command, { ...pool.modelEnv, ...input.env }),
    diagnostics: resolved.command
      ? []
      : [{ code: "AGENT_COMMAND_NOT_FOUND", message: resolved.message ?? `Command not found: ${tool.command}` }]
  };
}

export function buildLaunchEnv(command: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (path.isAbsolute(command)) {
    const dir = path.dirname(command);
    const key = Object.keys(env).find((entry) => entry.toLowerCase() === "path") ?? "PATH";
    const current = env[key] ?? "";
    const parts = current.split(path.delimiter).filter(Boolean);
    env[key] = [dir, ...parts.filter((part) => path.resolve(part) !== path.resolve(dir))].join(path.delimiter);
  }
  return env;
}

export function resolveRuntimeCommand(tool: AgentToolConfig, cwd: string): { command: string | null; message?: string } {
  const fallbackCommands = Array.isArray(tool.fallbackCommands) ? tool.fallbackCommands : [];
  const commands = [tool.command, ...fallbackCommands];
  const errors: string[] = [];
  for (const command of commands) {
    try {
      return { command: resolveCommandBinary(command, cwd) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const message = errors.at(-1);
  return message ? { command: null, message } : { command: null };
}
