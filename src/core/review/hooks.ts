import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type HookEvent =
  | "on_turn_start"
  | "on_turn_complete"
  | "on_push"
  | "on_blocked"
  | "on_file_change";

export interface HarnessHook {
  event: HookEvent;
  pattern?: string;
  command: string;
  timeout?: number;
}

export interface HookBlock {
  command: string;
  reason: string;
}

export interface HookContext {
  task: { id: string; title: string; description: string; agent: string };
  runId: string;
  prompt?: string;
  reply?: string;
  exitCode?: number;
  blockedReason?: string;
  branch?: string;
  commitCount?: number;
  diff?: string;
  changedFiles?: string[];
  workspace: { cwd: string; isRepo: boolean };
}

const DEFAULT_TIMEOUT_S = 60;

/** Parse `.harness/hooks.yml` via the shared YAML dependency. */
function parseHooksFile(text: string): HarnessHook[] {
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];

  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc["hooks"])) return [];

  const hooks: HarnessHook[] = [];
  for (const item of doc["hooks"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const event = typeof entry["event"] === "string" ? entry["event"].trim() : "";
    const command = typeof entry["command"] === "string" ? entry["command"].trim() : "";
    if (!isHookEvent(event) || !command) continue;

    const hook: HarnessHook = { event, command };
    if (typeof entry["pattern"] === "string" && entry["pattern"].trim()) {
      hook.pattern = entry["pattern"].trim();
    }
    if (typeof entry["timeout"] === "number" && Number.isFinite(entry["timeout"]) && entry["timeout"] > 0) {
      hook.timeout = Math.floor(entry["timeout"]);
    }
    hooks.push(hook);
  }

  return hooks;
}

const VALID_EVENTS: HookEvent[] = [
  "on_turn_start",
  "on_turn_complete",
  "on_push",
  "on_blocked",
  "on_file_change"
];

function isHookEvent(value: string): value is HookEvent {
  return (VALID_EVENTS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadHooksFrom(workspacePath: string): Promise<HarnessHook[]> {
  const candidate = path.join(workspacePath, ".harness", "hooks.yml");
  try {
    const text = await readFile(candidate, "utf8");
    return parseHooksFile(text);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runSingleHook(
  hook: HarnessHook,
  contextJson: string,
  cwd: string
): Promise<HookRunResult> {
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000;

  return new Promise((resolve) => {
    const child = spawn(hook.command, [], {
      cwd,
      shell: true,
      env: { ...process.env, PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message, timedOut: false });
    });

    // Pipe context JSON via stdin and close. Hooks that exit without reading stdin
    // can close the pipe early; ignore EPIPE so Vitest does not see an unhandled error.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") {
          clearTimeout(timer);
          resolve({ exitCode: 1, stdout, stderr: err.message, timedOut: false });
        }
      });
      stdin.write(contextJson);
      stdin.end();
    }
  });
}

/**
 * Run all hooks matching `event` from the workspace's `.harness/hooks.yml`.
 * Hooks execute sequentially. If a hook exits with code 2, the chain stops
 * and a `HookBlock` is returned. Returns `undefined` when no hook blocked.
 */
export async function runHooks(
  workspacePath: string,
  event: HookEvent,
  context: HookContext,
  onOutput?: (chunk: string) => void
): Promise<HookBlock | undefined> {
  const allHooks = await loadHooksFrom(workspacePath);
  const matching = allHooks.filter((h) => h.event === event);
  if (!matching.length) return undefined;

  // Filter by pattern for on_file_change.
  const hooksToRun =
    event === "on_file_change" && context.changedFiles?.length
      ? matching.filter((h) => {
          if (!h.pattern) return true;
          const re = globToRegex(h.pattern);
          return context.changedFiles!.some((f) => re.test(f));
        })
      : matching;

  const contextJson = JSON.stringify(context);

  for (const hook of hooksToRun) {
    onOutput?.(`\n[hook] ${hook.event}: ${hook.command}\n`);
    const result = await runSingleHook(hook, contextJson, workspacePath);

    if (result.timedOut) {
      onOutput?.(`[hook] timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_S}s\n`);
      continue;
    }

    if (result.exitCode === 2) {
      return { command: hook.command, reason: result.stderr.trim() || "Blocked by hook." };
    }

    if (result.exitCode !== 0) {
      onOutput?.(`[hook] non-blocking error (exit ${result.exitCode}): ${result.stderr.trim()}\n`);
    }
  }

  return undefined;
}

/**
 * Load and return all hooks for a workspace (for the API/MCP read endpoint).
 */
export async function listHooks(workspacePath: string): Promise<HarnessHook[]> {
  return loadHooksFrom(workspacePath);
}

// ---------------------------------------------------------------------------
// Glob → RegExp (minimal, enough for *.py, src/**/*.ts, etc.)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
