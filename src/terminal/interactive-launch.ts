import type { AgentToolConfig, ModelPoolConfig } from "../core/agents/config/types.ts";
import { resolveRuntimeCommand, buildLaunchEnv } from "../core/agents/runtime/launch.ts";
import type { EffortLevel } from "../core/types.ts";

export interface InteractiveLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InteractiveLaunchOptions {
  effort?: EffortLevel | string;
  mode?: "execute" | "plan" | "classify";
  sessionId?: string;
  /**
   * Full harness task prompt. Passed as the CLI positional prompt so the TUI
   * starts the same work headless would — not pasted after the fact.
   */
  prompt?: string;
  /**
   * Absolute path to the already-written prompt.md (run dir). Used when the
   * prompt is too large for argv.
   */
  promptFile?: string;
}

/** Keep interactive argv under typical OS ARG_MAX headroom. */
export const INTERACTIVE_PROMPT_ARGV_MAX_BYTES = 24_000;

/**
 * Build the trailing prompt argument for an interactive agent CLI.
 * Large prompts reference promptFile so the agent still gets full harness context.
 */
export function interactivePromptArgv(
  prompt: string | undefined,
  promptFile?: string
): string[] {
  const trimmed = (prompt ?? "").trim();
  if (!trimmed && !promptFile) return [];

  if (trimmed) {
    const bytes = Buffer.byteLength(trimmed, "utf8");
    if (bytes <= INTERACTIVE_PROMPT_ARGV_MAX_BYTES) {
      return [trimmed];
    }
  }

  if (promptFile) {
    return [
      "Mission Control interactive task.\n" +
        "Read the full task instructions from this file and begin the work immediately " +
        "(do not wait for further operator input before starting):\n\n" +
        `${promptFile}\n\n` +
        "When the step is finished, stop and wait — the operator marks Done in the UI " +
        "(quitting the CLI alone does not advance the workflow)."
    ];
  }

  if (!trimmed) return [];
  return [
    `${trimmed.slice(0, INTERACTIVE_PROMPT_ARGV_MAX_BYTES)}\n\n` +
      "…[prompt truncated for interactive launch; full text unavailable]"
  ];
}

/**
 * Build argv for an interactive (TUI) agent session — not headless print/exec.
 * Honors the same model pool args, effort flags, plan/execute modes, and the
 * harness prompt as the CLI's initial PROMPT argument.
 * Returns null when the tool has no sensible interactive entry (e.g. pure ACP).
 */
export function buildInteractiveLaunch(
  tool: AgentToolConfig,
  pool: ModelPoolConfig | null,
  cwd: string,
  options: InteractiveLaunchOptions = {}
): InteractiveLaunchSpec | null {
  if (tool.adapter === "acp") return null;

  const resolved = resolveRuntimeCommand(tool, cwd);
  if (!resolved.command) {
    throw new Error(resolved.message ?? `Command not found: ${tool.command}`);
  }

  const modelArgs = pool?.modelArgs ?? [];
  const modelEnv = pool?.modelEnv ?? {};
  const args = interactiveArgsForAdapter(tool, modelArgs, options);
  const envRecord: Record<string, string> = {};
  const merged = buildLaunchEnv(resolved.command, modelEnv);
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) envRecord[key] = value;
  }

  return {
    command: resolved.command,
    args,
    env: envRecord
  };
}

function effortArgs(tool: AgentToolConfig, effort: string | undefined): string[] {
  if (!effort) return [];
  const cli = tool.cli;
  if (cli.effortFlag) return [cli.effortFlag, effort];
  if (cli.effortConfigKey) return ["-c", `${cli.effortConfigKey}=${effort}`];
  return [];
}

function interactiveArgsForAdapter(
  tool: AgentToolConfig,
  modelArgs: string[],
  options: InteractiveLaunchOptions
): string[] {
  const effort = typeof options.effort === "string" ? options.effort : undefined;
  const mode = options.mode ?? "execute";
  const sessionId = options.sessionId;
  const promptArgv = interactivePromptArgv(options.prompt, options.promptFile);
  const args: string[] = [];

  switch (tool.adapter) {
    case "claude": {
      // Full TUI: no -p. Model + effort + permission mode still apply.
      // Prompt is the positional [prompt] so Claude starts the turn immediately.
      if (mode === "plan" || mode === "classify") {
        args.push("--permission-mode", mode === "classify" ? "default" : "plan");
      } else {
        args.push("--dangerously-skip-permissions");
      }
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      if (sessionId) args.push("--resume", sessionId);
      args.push(...promptArgv);
      return args;
    }
    case "codex": {
      // Interactive codex (not `exec`). Same model/effort as headless.
      // Plan/conversation steps use read-only sandbox like headless plan mode.
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      if (mode === "plan" || mode === "classify") {
        const sandbox = tool.cli.permissionModes?.plan ?? "read-only";
        args.push("-s", sandbox);
      }
      if (sessionId) {
        // Subcommand form: codex [opts] resume <id>
        return [...args, "resume", sessionId, ...promptArgv];
      }
      args.push(...promptArgv);
      return args;
    }
    case "grok": {
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      args.push(...promptArgv);
      return args;
    }
    case "opencode": {
      // Bare `opencode` enters the TUI (not `run`).
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      if (sessionId) args.push("--session", sessionId);
      args.push(...promptArgv);
      return args;
    }
    case "generic": {
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      args.push(...promptArgv);
      return args;
    }
    default:
      args.push(...effortArgs(tool, effort));
      args.push(...modelArgs);
      args.push(...promptArgv);
      return args;
  }
}

/** Login shell for a bare terminal (operator "Open shell"). */
export function buildShellLaunch(cwd: string): InteractiveLaunchSpec {
  const shell = process.env["SHELL"] || "/bin/zsh";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  return {
    command: shell,
    // Non-login interactive shell for the PTY itself is OK: this IS the terminal.
    // Env was already captured via login shell at process start.
    args: ["-i"],
    env: { ...env, PWD: cwd }
  };
}
