import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_KERNEL_FILES } from "./defaults/kernel.ts";
import { migrateRuntimeAssets } from "./runtime-assets/index.ts";
import { ensureDir, writeFileIfMissing } from "../infra/fs.ts";
import { DEFAULT_HARNESS_SETTINGS } from "../settings.ts";

/** Legacy runtime-state location; state is migrated away from here once. */
const LEGACY_HARNESS_ROOT = path.join(os.homedir(), "codex", "harness");

/** Marker file whose presence means a root has already been seeded with state. */
const SEEDED_MARKER = path.join("data", "state", "tasks.json");

/** Subdirectories that constitute personal runtime state (not source). */
const STATE_SUBDIRS = ["data", "kernel", "skills"] as const;

/**
 * Platform-appropriate default for runtime state. Kept outside any source
 * checkout so cloning the repo never collides with or seeds personal state.
 */
function computeDefaultHarnessRoot(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "mission-control");
    case "win32": {
      const appData = process.env["APPDATA"];
      return appData
        ? path.join(appData, "mission-control")
        : path.join(home, "AppData", "Roaming", "mission-control");
    }
    default: {
      // Linux and other POSIX: honor XDG_DATA_HOME.
      const xdgData = process.env["XDG_DATA_HOME"];
      const base = xdgData ? xdgData : path.join(home, ".local", "share");
      return path.join(base, "mission-control");
    }
  }
}

export const DEFAULT_HARNESS_ROOT = computeDefaultHarnessRoot();

function looksSeeded(root: string): boolean {
  return existsSync(path.join(root, SEEDED_MARKER));
}

/**
 * One-time, non-destructive migration of runtime state from the legacy
 * `~/codex/harness` location (which collided with source checkouts) to the new
 * platform default. Only the state subdirectories (data/kernel/skills) are
 * copied, never node_modules/.git/src. Runs only when the target is the default
 * root (so test temp dirs are untouched) and only when the target is unseeded
 * while the legacy root holds real state. The legacy copy is left in place as a
 * backup; nothing is deleted.
 */
async function migrateLegacyRootIfNeeded(root: string): Promise<void> {
  if (root === LEGACY_HARNESS_ROOT) return;
  if (root !== DEFAULT_HARNESS_ROOT) return;
  if (looksSeeded(root)) return;
  if (!looksSeeded(LEGACY_HARNESS_ROOT)) return;

  console.log(`Migrating harness state from ${LEGACY_HARNESS_ROOT} to ${root} ...`);
  try {
    for (const sub of STATE_SUBDIRS) {
      const src = path.join(LEGACY_HARNESS_ROOT, sub);
      if (existsSync(src)) {
        await cp(src, path.join(root, sub), { recursive: true });
      }
    }
    console.log("Migration complete. The old location was left in place as a backup.");
  } catch (err) {
    console.warn(`Migration skipped: ${(err as Error).message}. Continuing with a fresh root.`);
  }
}

export async function ensureHarnessRepository(root = DEFAULT_HARNESS_ROOT): Promise<void> {
  await migrateLegacyRootIfNeeded(root);

  for (const dir of [
    "kernel",
    "skills",
    "workflows",
    "data/runs",
    "data/state",
    "data/state/memory-index",
    "data/memory",
    "data/memory/pages"
  ]) {
    await ensureDir(path.join(root, dir));
  }

  for (const [fileName, content] of Object.entries(DEFAULT_KERNEL_FILES)) {
    await writeFileIfMissing(path.join(root, "kernel", fileName), content);
  }

  await writeFileIfMissing(path.join(root, "skills", "README.md"), "# Mission Control Skills\n\nApproved reusable skills live here.\n");
  await migrateRuntimeAssets(root);
  await writeFileIfMissing(path.join(root, "data", "runs", ".gitkeep"), "");
  await writeFileIfMissing(path.join(root, "data", "state", "tasks.json"), "[]\n");
  await writeFileIfMissing(path.join(root, "data", "state", "runs.json"), "[]\n");
  await writeFileIfMissing(
    path.join(root, "data", "state", "settings.json"),
    JSON.stringify(
      {
        defaultAgent: DEFAULT_HARNESS_SETTINGS.defaultAgent,
        activityThresholds: DEFAULT_HARNESS_SETTINGS.activityThresholds,
        theme: DEFAULT_HARNESS_SETTINGS.theme,
        projectsRoot: DEFAULT_HARNESS_SETTINGS.projectsRoot
      },
      null,
      2
    ) + "\n"
  );
}
