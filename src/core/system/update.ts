import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { isBehind, parseLatestVersion } from "./version.ts";
import { listAllRuns, updateRun } from "../tasks/runs.ts";
import { pauseTask } from "../tasks/tasks.ts";
import { abortAllInflightTurns, abortInflightTurn, listInflightTaskIds } from "../../runtime/sessions.ts";

const NPM_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_TTL_MS = 60 * 60 * 1000;
const IDLE_POLL_MS = 15_000;

/** Minimal fetch shape for the npm registry lookup. The global fetch satisfies it. */
export interface RegistryFetch {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface UpdateOutcome {
  result: "ok" | "failed";
  from: string | null;
  to: string | null;
  at: string;
  message?: string;
}

export interface VersionStatus {
  installed: string | null;
  latest: string | null;
  behind: boolean;
  fetchedAt: string | null;
  canSelfUpdate: boolean;
  lastUpdate: UpdateOutcome | null;
}

let registryCache: { version: string | null; fetchedAt: string | null } | null = null;

/** Test hook: drop the in-process registry cache. */
export function resetVersionCache(): void {
  registryCache = null;
}

/** Resolve the latest published version for a package, with a TTL cache. */
export async function fetchLatestVersion(
  packageName: string | null,
  fetchFn?: RegistryFetch
): Promise<{ version: string | null; fetchedAt: string | null }> {
  const now = Date.now();
  if (registryCache && registryCache.fetchedAt && now - Date.parse(registryCache.fetchedAt) < REGISTRY_TTL_MS) {
    return registryCache;
  }
  if (!packageName) return { version: registryCache?.version ?? null, fetchedAt: registryCache?.fetchedAt ?? null };

  const fetchImpl = fetchFn ?? (globalThis.fetch as unknown as RegistryFetch | undefined);
  if (!fetchImpl) return { version: registryCache?.version ?? null, fetchedAt: registryCache?.fetchedAt ?? null };

  try {
    const res = await fetchImpl(`${NPM_REGISTRY}/${packageName}/latest`);
    if (!res.ok) return { version: registryCache?.version ?? null, fetchedAt: registryCache?.fetchedAt ?? null };
    const version = parseLatestVersion(await res.text());
    registryCache = { version, fetchedAt: new Date(now).toISOString() };
    return registryCache;
  } catch {
    // Network or registry failure: keep serving a stale cache if we have one.
    return { version: registryCache?.version ?? null, fetchedAt: registryCache?.fetchedAt ?? null };
  }
}

export interface VersionStatusDeps {
  packageRoot: string;
  packageName: string | null;
  installed: string | null;
  fetch?: RegistryFetch;
}

/** Build the version status the header pill renders from. */
export async function getVersionStatus(deps: VersionStatusDeps): Promise<VersionStatus> {
  const latest = await fetchLatestVersion(deps.packageName, deps.fetch);
  return {
    installed: deps.installed,
    latest: latest.version,
    behind: isBehind(deps.installed ?? "", latest.version ?? ""),
    fetchedAt: latest.fetchedAt,
    canSelfUpdate: await canSelfUpdate(deps.packageRoot, deps.packageName, deps.installed),
    lastUpdate: null
  };
}

async function canSelfUpdate(packageRoot: string, packageName: string | null, installed: string | null): Promise<boolean> {
  if (!packageName || !installed) return false;
  try {
    await access(path.join(packageRoot, "dist", "server.js"));
    return true;
  } catch {
    return false;
  }
}

/** True when nothing is running: no active runs and no inflight agent turns. */
export async function isSystemIdle(root: string): Promise<boolean> {
  const runs = await listAllRuns(root);
  if (runs.some((run) => run.status === "running")) return false;
  return listInflightTaskIds().length === 0;
}

/**
 * Pause every running run and abort inflight turns so an update can proceed.
 * Runs are paused (resumable), not destroyed; reconciliation on next boot
 * recovers interrupted work.
 */
export async function stopAllWork(root: string): Promise<{ runs: number; aborted: number }> {
  const runs = await listAllRuns(root);
  const active = runs.filter((run) => run.status === "running");
  const completedAt = new Date().toISOString();
  let aborted = 0;
  for (const run of active) {
    if (run.taskId && abortInflightTurn(run.taskId)) aborted += 1;
    if (run.taskId) {
      // Pause best-effort: an orphaned run may reference a task that no longer
      // exists, but the run itself still needs to be marked stopped below.
      try {
        await pauseTask(root, run.taskId, { completedAt, blockedReason: "Stopped for app update", runId: run.id });
      } catch {
        /* task missing; the run update below is the authoritative stop */
      }
    }
    await updateRun(root, run.id, { status: "paused", completedAt, blockedReason: "Stopped for app update" });
  }
  // Backstop for inflight turns not tied to a persisted running run.
  abortAllInflightTurns();
  return { runs: active.length, aborted };
}

export function updateStatusPath(root: string): string {
  return path.join(root, ".mission-control", "update-status.json");
}

/** Read a fresh (<=1h) update outcome written by the detached updater, else null. */
export async function readUpdateOutcome(root: string): Promise<UpdateOutcome | null> {
  try {
    const parsed = JSON.parse(await readFile(updateStatusPath(root), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const result = o["result"];
    const at = o["at"];
    if (result !== "ok" && result !== "failed") return null;
    if (typeof at !== "string") return null;
    const age = Date.now() - Date.parse(at);
    if (!Number.isFinite(age) || age > STATUS_TTL_MS || age < -60_000) return null;
    const outcome: UpdateOutcome = {
      result,
      at,
      from: typeof o["from"] === "string" ? (o["from"] as string) : null,
      to: typeof o["to"] === "string" ? (o["to"] as string) : null
    };
    if (typeof o["message"] === "string") outcome.message = o["message"] as string;
    return outcome;
  } catch {
    return null;
  }
}

export async function writeUpdateOutcome(root: string, outcome: UpdateOutcome): Promise<void> {
  await mkdir(path.dirname(updateStatusPath(root)), { recursive: true });
  await writeFile(updateStatusPath(root), JSON.stringify(outcome, null, 2));
}

export interface ApplyContext {
  root: string;
  packageRoot: string;
  packageName: string;
  fromVersion: string | null;
  /** Spawn the detached updater. Override in tests. Defaults to a real detached spawn. */
  spawnUpdater?: (script: string, env: NodeJS.ProcessEnv) => boolean;
  /** Schedule process exit after the updater is spawned. Override in tests. */
  scheduleExit?: () => void;
}

/**
 * Hand off the update to a detached updater copied to a temp file (so it
 * survives the package directory being replaced by `npm i -g`). Returns
 * spawned=false when the updater script could not be copied or spawned; in that
 * case the process is NOT exited, so the running app stays alive.
 */
export async function applyUpdate(ctx: ApplyContext): Promise<{ spawned: boolean }> {
  const scriptSrc = path.join(ctx.packageRoot, "scripts", "apply-update.mjs");
  const tmpScript = path.join(os.tmpdir(), `mc-apply-update-${process.pid}-${Date.now()}.mjs`);
  try {
    await copyFile(scriptSrc, tmpScript);
  } catch {
    return { spawned: false };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MC_UPDATE_PARENT_PID: String(process.pid),
    MC_UPDATE_PACKAGE: ctx.packageName,
    MC_UPDATE_ORIG_ROOT: ctx.packageRoot,
    MC_UPDATE_HARNESS_ROOT: ctx.root,
    MC_UPDATE_STATUS_FILE: updateStatusPath(ctx.root),
    MC_UPDATE_FROM_VERSION: ctx.fromVersion ?? "",
    MC_UPDATE_PORT: process.env["PORT"] ?? "",
    MC_UPDATE_HOST: process.env["HARNESS_HOST"] ?? process.env["HOST"] ?? ""
  };

  const spawnFn = ctx.spawnUpdater ?? defaultSpawnUpdater;
  if (!spawnFn(tmpScript, env)) return { spawned: false };

  (ctx.scheduleExit ?? defaultScheduleExit)();
  return { spawned: true };
}

function defaultSpawnUpdater(script: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore", env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function defaultScheduleExit(): void {
  setTimeout(() => process.exit(0), 500).unref();
}

let idleCtx: ApplyContext | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/** Queue an update to apply automatically on the next idle transition. */
export function queueIdleUpdate(ctx: ApplyContext): void {
  idleCtx = ctx;
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    void pollIdleUpdateNow();
  }, IDLE_POLL_MS);
  idleTimer.unref?.();
}

export function hasQueuedIdleUpdate(): boolean {
  return idleCtx !== null;
}

export function cancelIdleUpdate(): void {
  idleCtx = null;
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** One idle check. Exported so tests and the interval share a single path. */
export async function pollIdleUpdateNow(): Promise<void> {
  if (!idleCtx) return;
  const ctx = idleCtx;
  if (!(await isSystemIdle(ctx.root))) return;
  idleCtx = null;
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  await applyUpdate(ctx);
}
