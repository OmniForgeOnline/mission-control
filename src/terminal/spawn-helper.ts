import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * node-pty 1.x ships darwin `spawn-helper` prebuilds as mode 644 in the npm
 * tarball (microsoft/node-pty#850). Without +x, pty.spawn fails with the
 * opaque error `posix_spawnp failed`. Fix permissions under the installed
 * package's prebuilds/ tree. Returns paths that were updated.
 */
export function ensureNodePtySpawnHelpersExecutable(packageRoot: string): string[] {
  const prebuilds = path.join(packageRoot, "prebuilds");
  if (!existsSync(prebuilds)) return [];

  const fixed: string[] = [];
  for (const platform of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0o111) continue;
      chmodSync(helper, mode | 0o755);
      fixed.push(helper);
    } catch {
      /* ignore unreadable/unwritable helpers */
    }
  }
  return fixed;
}

/** Resolve the installed node-pty package root and fix spawn-helper bits. */
export function ensureInstalledNodePtySpawnHelpers(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    // entry is .../node-pty/lib/index.js (or similar)
    const root = path.resolve(path.dirname(entry), "..");
    return ensureNodePtySpawnHelpersExecutable(root);
  } catch {
    return [];
  }
}
