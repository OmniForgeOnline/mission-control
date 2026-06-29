import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PackageMeta {
  name: string | null;
  version: string | null;
}

/**
 * Compare two versions as numeric release segments (major.minor.patch).
 * Returns a negative number when `a` is older than `b`, zero when equal, and a
 * positive number when `a` is newer.
 *
 * Scope: Mission Control is published as plain releases (the npm `latest`
 * dist-tag never points at a prerelease), so we only need release-segment
 * comparison. A leading `v` is tolerated, and a prerelease suffix on an
 * otherwise-equal release is treated as lower than the release (so a local
 * prerelease build still reads as behind the published release). Build
 * metadata (`+...`) is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = releaseSegments(a);
  const bParts = releaseSegments(b);
  const len = Math.max(aParts.nums.length, bParts.nums.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (aParts.nums[i] ?? 0) - (bParts.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Release segments equal: a version carrying a prerelease tag is lower.
  if (aParts.pre && !bParts.pre) return -1;
  if (!aParts.pre && bParts.pre) return 1;
  return 0;
}

function releaseSegments(version: string): { nums: number[]; pre: string | null } {
  const cleaned = version.trim().replace(/^v/i, "");
  const dashParts = cleaned.split(/-(.+)/);
  const release = dashParts[0] ?? "";
  const prerelease = dashParts[1] ?? null;
  const releaseCore = (release.split("+")[0] ?? "").split(".");
  const nums = releaseCore.map((segment) => {
    const parsed = Number.parseInt(segment, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const pre = prerelease ? (prerelease.split("+")[0] ?? null) : null;
  return { nums, pre };
}

/** True only when `installed` is strictly older than `latest`. */
export function isBehind(installed: string, latest: string): boolean {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}

/**
 * Pull the `version` string out of an npm registry `/<package>/latest` JSON
 * body. Returns null for anything that is not a string version.
 */
export function parseLatestVersion(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      return typeof version === "string" && version.length > 0 ? version : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the published name and version from a package's own package.json. */
export async function readPackageMeta(packageRoot: string): Promise<PackageMeta> {
  try {
    const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null
    };
  } catch {
    return { name: null, version: null };
  }
}
