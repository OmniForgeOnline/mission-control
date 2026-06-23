import path from "node:path";

import type { EffortLevel } from "../core/types.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../core/agents/config/types.ts";

export interface LaunchRequest {
  mode: "execute" | "plan";
  prompt: string;
  cwd: string;
  effort?: EffortLevel;
  sessionId?: string;
  /** Extra directories the agent may touch (claude --add-dir). */
  allowedDirs?: string[];
  /** Run as a live bidirectional session (persistent stdin, stream-json input). */
  live?: boolean;
}

export interface LaunchSpec {
  args: string[];
  env: Record<string, string>;
  /** When false, the prompt is passed as a CLI arg instead of on stdin (grok). */
  promptOnStdin: boolean;
  /**
   * When true, the prompt and operator messages are delivered as stream-json
   * user messages on a persistent stdin (Claude live mode), not as plain text.
   */
  inputStreamJson?: boolean;
}

export type RuntimeCapabilityProbe = Record<string, boolean>;

function uniqueDirs(request: LaunchRequest): string[] {
  const dirs = new Set<string>([path.resolve(request.cwd)]);
  for (const dir of request.allowedDirs ?? []) {
    if (dir) dirs.add(path.resolve(dir));
  }
  return [...dirs];
}

function grokArgs(tool: AgentToolConfig, pool: ModelPoolConfig, request: LaunchRequest): LaunchSpec {
  const isPlan = request.mode === "plan";
  const cli = tool.cli;
  const args = [
    "--single",
    request.prompt,
    "--output-format",
    cli.outputFormat ?? "streaming-json",
    "--permission-mode",
    (isPlan ? cli.permissionModes?.plan : cli.permissionModes?.execute) ??
      (isPlan ? "plan" : "bypassPermissions"),
    "--cwd",
    request.cwd,
    ...pool.modelArgs
  ];
  if (!isPlan && cli.alwaysApproveInExecute) args.push("--always-approve");
  if (request.sessionId) args.push("--resume", request.sessionId);
  return { args, env: { ...pool.modelEnv }, promptOnStdin: false };
}

function claudeArgs(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  request: LaunchRequest,
  runtimeCapabilities: RuntimeCapabilityProbe = {}
): LaunchSpec {
  const isPlan = request.mode === "plan";
  const cli = tool.cli;
  const live = request.live === true;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    live ? "stream-json" : "text",
    "--verbose",
    ...(live && runtimeCapabilities["partialMessages"] === true ? ["--include-partial-messages"] : []),
    isPlan ? "--permission-mode" : "--dangerously-skip-permissions",
    ...(isPlan ? ["plan"] : [])
  ];
  if (runtimeCapabilities["addDir"] !== false) {
    for (const dir of uniqueDirs(request)) args.push("--add-dir", dir);
  }
  if (request.effort && cli.effortFlag) args.push(cli.effortFlag, request.effort);
  args.push(...pool.modelArgs);
  if (request.sessionId) args.push("--resume", request.sessionId);
  return { args, env: { ...pool.modelEnv }, promptOnStdin: true, ...(live ? { inputStreamJson: true } : {}) };
}

function codexArgs(tool: AgentToolConfig, pool: ModelPoolConfig, request: LaunchRequest): LaunchSpec {
  const isPlan = request.mode === "plan";
  const cli = tool.cli;
  const sandbox = isPlan
    ? cli.permissionModes?.plan ?? "read-only"
    : cli.permissionModes?.execute ?? "workspace-write";
  const effortConfig =
    cli.effortConfigKey && request.effort ? [`-c`, `${cli.effortConfigKey}=${request.effort}`] : [];
  const outputArgs = ["--json", "--skip-git-repo-check"];
  if (request.sessionId) {
    // `exec resume` rejects -C/-s; cwd is pinned by the spawn cwd.
    return {
      args: ["exec", "resume", request.sessionId, ...outputArgs, ...effortConfig, ...pool.modelArgs],
      env: { ...pool.modelEnv },
      promptOnStdin: true
    };
  }
  return {
    args: ["exec", ...outputArgs, "-C", request.cwd, ...effortConfig, "-s", sandbox, ...pool.modelArgs],
    env: { ...pool.modelEnv },
    promptOnStdin: true
  };
}

function opencodeArgs(tool: AgentToolConfig, pool: ModelPoolConfig, request: LaunchRequest): LaunchSpec {
  const isPlan = request.mode === "plan";
  const cli = tool.cli;
  const args = [
    "run",
    "--format",
    cli.outputFormat ?? "json",
    "--dir",
    request.cwd,
    ...pool.modelArgs
  ];
  if (!isPlan) {
    args.push("--dangerously-skip-permissions");
  }
  if (request.effort && cli.effortFlag && !isPlan) args.push(cli.effortFlag, request.effort);
  if (request.sessionId) args.push("--session", request.sessionId);
  return { args, env: { ...pool.modelEnv }, promptOnStdin: true };
}

function substituteToken(token: string, pool: ModelPoolConfig, request: LaunchRequest): string[] {
  switch (token) {
    case "{prompt}":
      return [request.prompt];
    case "{cwd}":
      return [request.cwd];
    case "{model}":
      return [...pool.modelArgs];
    case "{effort}":
      return request.effort ? [request.effort] : [];
    case "{session}":
      return request.sessionId ? [request.sessionId] : [];
    default:
      return [token];
  }
}

/** Generic adapter: expand the tool's command template, injecting model args/env. */
function genericArgs(tool: AgentToolConfig, pool: ModelPoolConfig, request: LaunchRequest): LaunchSpec {
  const template = tool.commandTemplate ?? [];
  const args: string[] = [];
  for (const token of template) {
    args.push(...substituteToken(token, pool, request));
  }
  // If the template never consumes {model}, still inject model args so model
  // selection is honored for tools that don't template it explicitly.
  if (!template.includes("{model}")) args.push(...pool.modelArgs);
  const promptOnStdin = !template.includes("{prompt}");
  return { args, env: { ...pool.modelEnv }, promptOnStdin };
}

/**
 * Build the launch args/env for a tool + model pool. Built-in adapters preserve
 * their bespoke CLI behavior; `generic` expands the tool's command template.
 */
export function buildLaunchArgs(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  request: LaunchRequest,
  runtimeCapabilities: RuntimeCapabilityProbe = {}
): LaunchSpec {
  switch (tool.adapter) {
    case "grok":
      return grokArgs(tool, pool, request);
    case "claude":
      return claudeArgs(tool, pool, request, runtimeCapabilities);
    case "codex":
      return codexArgs(tool, pool, request);
    case "opencode":
      return opencodeArgs(tool, pool, request);
    case "generic":
      return genericArgs(tool, pool, request);
    case "acp":
      throw new Error("ACP agents run via AcpAgentRunner, not buildLaunchArgs.");
  }
}
