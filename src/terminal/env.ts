import { ensureLoginShellEnvironment } from "../core/agents/resolver.ts";

/**
 * Build a plain string env map suitable for node-pty / child_process spawn.
 * Ensures login-shell PATH is present, then pins terminal identity vars.
 */
export function buildPtyEnvironment(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // Cheap no-op when already applied at process start; safe to call again.
  ensureLoginShellEnvironment();

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, extra);
  env["TERM"] = extra["TERM"] ?? "xterm-256color";
  env["COLORTERM"] = extra["COLORTERM"] ?? "truecolor";
  return env;
}
