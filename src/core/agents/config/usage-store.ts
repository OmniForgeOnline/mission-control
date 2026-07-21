import path from "node:path";

import { matchesProviderLimit } from "../provider-failure.ts";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../../infra/fs.ts";
import { ensureHarnessRepository } from "../../bootstrap/repository.ts";
import type { ModelPoolId, ToolId } from "../../types.ts";
import { emptyUsageSnapshots, type UsageSnapshot, type UsageSnapshots } from "./usage.ts";

function usagePath(root: string): string {
  return path.join(root, "data", "state", "usage-snapshots.json");
}

function sameTarget(a: UsageSnapshot, toolId: ToolId, modelPoolId?: ModelPoolId): boolean {
  return a.toolId === toolId && (a.modelPoolId ?? undefined) === (modelPoolId ?? undefined);
}

export async function loadUsageSnapshots(root: string): Promise<UsageSnapshots> {
  await ensureHarnessRepository(root);
  return readJsonFile<UsageSnapshots>(usagePath(root), emptyUsageSnapshots());
}

export async function saveUsageSnapshots(root: string, usage: UsageSnapshots): Promise<void> {
  await writeJsonFile(usagePath(root), usage);
}

/** Insert or replace the snapshot for a tool (and optional model pool). */
export async function upsertUsageSnapshot(root: string, snapshot: UsageSnapshot): Promise<UsageSnapshots> {
  await ensureHarnessRepository(root);
  return updateJsonFile<UsageSnapshots>(usagePath(root), emptyUsageSnapshots(), (current) => {
    const snapshots = current.snapshots.filter(
      (entry) => !sameTarget(entry, snapshot.toolId, snapshot.modelPoolId)
    );
    snapshots.push(snapshot);
    return { snapshots, refreshedAt: new Date().toISOString() };
  });
}

/**
 * Detect credit/quota exhaustion from an agent turn's blocked reason.
 * When detected, write an exhausted usage snapshot so the optimizer skips
 * the tool/pool on subsequent routing attempts.
 *
 * Returns true when exhaustion was detected and recorded.
 */
export async function markPoolExhaustedFromFailure(
  root: string,
  toolId: ToolId,
  modelPoolId: ModelPoolId,
  blockedReason: string | undefined
): Promise<boolean> {
  if (!blockedReason) return false;
  if (!matchesProviderLimit(blockedReason)) return false;

  const now = new Date();
  const resetsAt = Math.floor(now.getTime() / 1000) + 30 * 60; // 30-minute cooldown
  await upsertUsageSnapshot(root, {
    toolId,
    modelPoolId,
    used: 0,
    usedPercent: 100,
    windowMinutes: 30,
    windowLabel: "runtime-detected",
    resetsAt,
    fetchedAt: now.toISOString(),
    source: "cli"
  });
  console.log(`usage: marked ${toolId}/${modelPoolId} exhausted (runtime detection, resets in 30m)`);
  return true;
}

/**
 * Clear runtime-detected exhaustion snapshots whose cooldown has expired.
 * Called during usage refresh so stale blocks don't persist indefinitely.
 */
export async function clearExpiredRuntimeExhaustion(root: string): Promise<void> {
  const usage = await loadUsageSnapshots(root);
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  const snapshots = usage.snapshots.filter((snapshot) => {
    if (snapshot.source !== "cli" || snapshot.resetsAt === undefined) return true;
    if (snapshot.resetsAt <= now) {
      changed = true;
      console.log(`usage: clearing expired exhaustion for ${snapshot.toolId}/${snapshot.modelPoolId ?? "default"}`);
      return false;
    }
    return true;
  });
  if (changed) {
    await saveUsageSnapshots(root, { snapshots, refreshedAt: usage.refreshedAt });
  }
}
