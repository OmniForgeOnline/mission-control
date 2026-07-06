import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface FileLockOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  staleMs?: number;
}

const DEFAULT_FILE_LOCK_OPTIONS: Required<FileLockOptions> = {
  maxAttempts: 100,
  retryDelayMs: 25,
  staleMs: 30_000
};

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLockMeta(lockPath: string): Promise<{ pid: number; acquiredAt: number; owner?: string } | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown; owner?: unknown };
    if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "number") {
      return {
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {})
      };
    }
  } catch {
    /* missing or corrupt lock metadata */
  }
  return null;
}

async function tryClearStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const meta = await readLockMeta(lockPath);
  if (meta) {
    const ageMs = Date.now() - meta.acquiredAt;
    const alive = await isPidAlive(meta.pid);
    if (ageMs > staleMs || !alive) {
      try {
        await rm(lockPath, { force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  // The lock file exists but its metadata could not be parsed. This happens in the
  // brief window after a holder creates the file (O_EXCL) but before its content is
  // fully written — the file reads back empty. Clearing it now would steal a live
  // holder's lock and break mutual exclusion (causing lost updates). Only treat it
  // as clearable when the file is genuinely gone, or has stayed unreadable past the
  // stale window (a holder that crashed mid-write).
  let ageMs: number;
  try {
    const stats = await stat(lockPath);
    ageMs = Date.now() - stats.mtimeMs;
  } catch {
    return true; // file does not exist — nothing holds it
  }
  if (ageMs > staleMs) {
    try {
      await rm(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function acquireFileLock(lockPath: string, options: Required<FileLockOptions>): Promise<string> {
  const owner = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      await ensureDir(path.dirname(lockPath));
      const meta = { pid: process.pid, acquiredAt: Date.now(), owner };
      await writeFile(lockPath, `${JSON.stringify(meta)}\n`, { flag: "wx" });
      return owner;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await tryClearStaleLock(lockPath, options.staleMs)) {
        continue;
      }
      await sleep(options.retryDelayMs);
    }
  }
  throw new Error(`Timed out acquiring lock for ${lockPath}`);
}

async function releaseFileLock(lockPath: string, owner: string): Promise<void> {
  const meta = await readLockMeta(lockPath);
  if (meta?.owner !== owner) {
    return;
  }
  await rm(lockPath, { force: true });
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, "utf8");
  }
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Whether a path exists on disk (swallows ENOENT and other stat errors). */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, or `null` when it is missing or unreadable. */
export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tempPath = `${filePath}.${unique}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  updater: (current: T) => T | Promise<T>,
  lockOptions?: FileLockOptions
): Promise<T> {
  const options = { ...DEFAULT_FILE_LOCK_OPTIONS, ...lockOptions };
  const lockPath = lockPathFor(filePath);
  const owner = await acquireFileLock(lockPath, options);
  try {
    const current = await readJsonFile(filePath, fallback);
    const next = await updater(current);
    await writeJsonFile(filePath, next);
    return next;
  } finally {
    await releaseFileLock(lockPath, owner);
  }
}

export async function listFileNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function safeRootPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("Target path must be relative to the harness root.");
  }
  const resolved = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Target path must stay inside the harness root.");
  }
  return resolved;
}
