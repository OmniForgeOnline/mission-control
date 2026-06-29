import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_HARNESS_ROOT } from "../core/bootstrap/repository.ts";
import { ensureDir, writeJsonFile } from "../core/infra/fs.ts";

/**
 * Cross-process shutdown control. The running server writes a small info file
 * (pid + port + host) under the harness root on startup; `mission-control stop`
 * reads it in a separate process and asks the live server to shut down via its
 * /api/shutdown endpoint. This is the CLI counterpart to the UI shutdown button
 * and shares the same graceful backend path.
 */

export interface ServerInfo {
  /** OS process id of the running server. */
  pid: number;
  /** Port the HTTP server listens on. */
  port: number;
  /** Host the HTTP server listens on (loopback by default). */
  host: string;
  /** ISO timestamp the server started. */
  startedAt: string;
}

/** Location of the runtime server-info file under a harness root. */
export function serverInfoPath(root: string): string {
  return path.join(root, "data", "state", "server.json");
}

/** Record the running server's identity so `mission-control stop` can reach it. */
export async function writeServerInfo(root: string, info: ServerInfo): Promise<void> {
  await ensureDir(path.dirname(serverInfoPath(root)));
  await writeJsonFile(serverInfoPath(root), info);
}

/** Remove the server-info file (called during graceful shutdown). */
export async function removeServerInfo(root: string): Promise<void> {
  await rm(serverInfoPath(root), { force: true });
}

/** Read the recorded server info, or null when no server has registered. */
export async function readServerInfo(root: string): Promise<ServerInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(serverInfoPath(root), "utf8")) as Partial<ServerInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.host === "string"
    ) {
      return {
        pid: parsed.pid,
        port: parsed.port,
        host: parsed.host,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : ""
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the harness root the same way the server does. */
export function resolveHarnessRoot(): string {
  return process.env["HARNESS_ROOT"]?.trim() || DEFAULT_HARNESS_ROOT;
}

/** True when a process with this pid exists (or exists and is owned elsewhere). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = it exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StopOutcome {
  ok: boolean;
  message: string;
}

/**
 * Ask the running Mission Control server to shut down. Reads the server-info
 * file, POSTs to /api/shutdown, and returns a clear terminal outcome. Never
 * throws: callers print `message` and exit with `ok ? 0 : 1`.
 */
export async function stopRunningServer(root: string = resolveHarnessRoot()): Promise<StopOutcome> {
  const info = await readServerInfo(root);
  if (!info) {
    return { ok: false, message: "Mission Control is not running." };
  }
  if (!isPidAlive(info.pid)) {
    // Stale info left by a crashed/killed server. Clean it up so the next start
    // and subsequent stop calls report correctly.
    await removeServerInfo(root);
    return { ok: false, message: "Mission Control is not running (cleaned up stale state)." };
  }

  const url = `http://${info.host}:${info.port}/api/shutdown`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) {
      return {
        ok: false,
        message: `Mission Control did not acknowledge shutdown (HTTP ${res.status} at ${url}).`
      };
    }
    return {
      ok: true,
      message:
        `Mission Control (pid ${info.pid}) is shutting down. ` +
        `All running processes are being terminated and the UI at http://${info.host}:${info.port} ` +
        `will be unavailable until you restart it from the terminal with \`mission-control\`.`
    };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach Mission Control at ${url}: ${(err as Error).message}. ` +
        `If it is hung, kill pid ${info.pid} directly.`
    };
  }
}
