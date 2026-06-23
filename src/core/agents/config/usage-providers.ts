import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveCommandBinary } from "../resolver.ts";
import type { AgentToolConfig, ModelPoolConfig } from "./types.ts";
import type { UsageSnapshot } from "./usage.ts";

const execFileAsync = promisify(execFile);

/** Partial usage reading produced by a provider before it is keyed to a tool/pool. */
export interface UsageReading {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
  windowLabel?: string;
}

interface RateWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

/** Friendly label for a quota window duration. */
export function windowLabel(minutes?: number): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  if (minutes <= 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  if (minutes === 7 * 24 * 60) return "weekly";
  if (minutes === 24 * 60) return "daily";
  if (minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return "monthly";
  return `${Math.round(minutes / (24 * 60))}d`;
}

/** Map a codex app-server `account/rateLimits/read` result to the most-constraining window. */
export function mapCodexRateLimits(raw: unknown): UsageReading | null {
  const rl = (raw as { rateLimits?: { primary?: RateWindow; secondary?: RateWindow } })?.rateLimits;
  if (!rl) return null;
  const windows = [rl.primary, rl.secondary].filter((w): w is RateWindow => Boolean(w));
  let best: UsageReading | null = null;
  for (const w of windows) {
    const pct = typeof w.usedPercent === "number" ? w.usedPercent : undefined;
    if (pct === undefined) continue;
    if (!best || pct > best.usedPercent) {
      const label = windowLabel(w.windowDurationMins ?? undefined);
      best = {
        usedPercent: pct,
        ...(w.windowDurationMins ? { windowMinutes: w.windowDurationMins } : {}),
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
        ...(label ? { windowLabel: label } : {})
      };
    }
  }
  return best;
}

interface ClaudeWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** Map Anthropic's oauth/usage response to the most-constraining window. */
export function mapClaudeUsage(raw: unknown): UsageReading | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { five_hour?: ClaudeWindow | null; seven_day?: ClaudeWindow | null; seven_day_opus?: ClaudeWindow | null };
  const windows: Array<{ w: ClaudeWindow | null | undefined; minutes: number; label: string }> = [
    { w: r.five_hour, minutes: 300, label: "5h" },
    { w: r.seven_day, minutes: 7 * 24 * 60, label: "weekly" },
    { w: r.seven_day_opus, minutes: 7 * 24 * 60, label: "weekly (opus)" }
  ];
  let best: UsageReading | null = null;
  for (const { w, minutes, label } of windows) {
    const pct = typeof w?.utilization === "number" ? w.utilization : undefined;
    if (pct === undefined) continue;
    if (!best || pct > best.usedPercent) {
      const resetsAt = w?.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : undefined;
      best = {
        usedPercent: pct,
        windowMinutes: minutes,
        windowLabel: label,
        ...(resetsAt && Number.isFinite(resetsAt) ? { resetsAt } : {})
      };
    }
  }
  return best;
}

/** Injectable IO so the providers can be unit-tested without spawning/network. */
export interface UsageProviderDeps {
  fetchCodexRateLimits(command: string, cwd: string): Promise<unknown>;
  readClaudeOAuthToken(): Promise<string | null>;
  fetchClaudeUsage(token: string): Promise<unknown>;
}

/** Spawn `codex app-server` and read account rate limits over JSON-RPC. */
function defaultFetchCodexRateLimits(command: string, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try {
      bin = resolveCommandBinary(command, cwd);
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn(bin, ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("codex app-server timed out"))), 15_000);
    child.on("error", (err) => done(() => reject(err)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n"
          );
        } else if (msg.id === 2) {
          done(() => resolve(msg.result));
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "harness", version: "0.1.0", title: "harness" } }
      }) + "\n"
    );
  });
}

/** Read the Claude Code OAuth token from the macOS keychain or the Linux credentials file. */
async function defaultReadClaudeOAuthToken(): Promise<string | null> {
  const parse = (raw: string): string | null => {
    try {
      const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
      return typeof token === "string" && token ? token : null;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000 }
      );
      const token = parse(stdout.trim());
      if (token) return token;
    } catch {
      /* fall through to file */
    }
  }
  try {
    return parse(await readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

async function defaultFetchClaudeUsage(token: string): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "harness-usage/0.1.0"
    }
  });
  if (!res.ok) throw new Error(`Anthropic usage endpoint returned ${res.status}`);
  return res.json();
}

export const defaultUsageProviderDeps: UsageProviderDeps = {
  fetchCodexRateLimits: defaultFetchCodexRateLimits,
  readClaudeOAuthToken: defaultReadClaudeOAuthToken,
  fetchClaudeUsage: defaultFetchClaudeUsage
};

function snapshotFrom(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  reading: UsageReading
): UsageSnapshot {
  return {
    toolId: tool.id,
    modelPoolId: pool.id,
    used: 0,
    usedPercent: Math.max(0, Math.min(100, reading.usedPercent)),
    ...(reading.windowMinutes !== undefined ? { windowMinutes: reading.windowMinutes } : {}),
    ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
    ...(reading.windowLabel !== undefined ? { windowLabel: reading.windowLabel } : {}),
    fetchedAt: new Date().toISOString(),
    source: "cli"
  };
}

/**
 * Fetch live usage for a model pool based on its `usageSource`. Returns null when
 * the source is `none` or no subscription quota is available; an error snapshot
 * when a live fetch fails (so the UI can show the reason without fabricating data).
 */
export async function fetchPoolUsage(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  cwd: string,
  deps: UsageProviderDeps = defaultUsageProviderDeps
): Promise<UsageSnapshot | null> {
  try {
    if (pool.usageSource === "codex-app-server") {
      const reading = mapCodexRateLimits(await deps.fetchCodexRateLimits(tool.command, cwd));
      return reading ? snapshotFrom(tool, pool, reading) : null;
    }
    if (pool.usageSource === "claude-oauth") {
      const token = await deps.readClaudeOAuthToken();
      if (!token) return null; // API-key / third-party endpoint: no subscription quota to report.
      const reading = mapClaudeUsage(await deps.fetchClaudeUsage(token));
      return reading ? snapshotFrom(tool, pool, reading) : null;
    }
    return null;
  } catch (err) {
    return {
      toolId: tool.id,
      modelPoolId: pool.id,
      used: 0,
      fetchedAt: new Date().toISOString(),
      source: "cli",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
