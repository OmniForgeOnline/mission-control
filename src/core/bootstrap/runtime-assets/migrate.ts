import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../../infra/fs.ts";
import { resetWorkflowCache } from "../../workflows/cache.ts";
import { workflowsDir } from "../../workflows/paths.ts";
import {
  bundledSkillHash,
  bundledSkillIds,
  listBundledWorkflowIds,
  readBundledSkillBody,
  readBundledWorkflowHash,
  readBundledWorkflowText,
  workflowBundledHash
} from "./bundled.ts";
import { knownBundledHashes, recordBundledHashHistory } from "./hash-history.ts";
import {
  readRuntimeAssetsManifest,
  writeRuntimeAssetsManifest
} from "./manifest.ts";
import type { RuntimeAssetMigrationResult, RuntimeAssetsManifest } from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function readRuntimeWorkflowText(root: string, workflowId: string): Promise<string | null> {
  for (const ext of [".yml", ".yaml"]) {
    const filePath = path.join(workflowsDir(root), `${workflowId}${ext}`);
    try {
      return await readFile(filePath, "utf8");
    } catch {
      /* try next extension */
    }
  }
  return null;
}

async function readRuntimeSkillBody(root: string, skillId: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, "skills", skillId, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

async function writeRuntimeWorkflow(root: string, workflowId: string, text: string): Promise<void> {
  const filePath = path.join(workflowsDir(root), `${workflowId}.yml`);
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, text, "utf8");
}

async function writeRuntimeSkill(root: string, skillId: string, body: string): Promise<void> {
  const dir = path.join(root, "skills", skillId);
  await ensureDir(dir);
  await writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

async function listRuntimeWorkflowIds(root: string): Promise<string[]> {
  const dir = workflowsDir(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => entry.replace(/\.ya?ml$/, ""))
    .filter((id) => id !== "ticket")
    .sort();
}

async function listRuntimeSkillIds(root: string): Promise<string[]> {
  const dir = path.join(root, "skills");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of entries) {
    if (name === "README.md") continue;
    try {
      await readFile(path.join(dir, name, "SKILL.md"), "utf8");
      ids.push(name);
    } catch {
      /* skip */
    }
  }
  return ids.sort();
}

interface AssetDecision {
  action: "install" | "upgrade" | "review" | "noop";
  bundledHash: string;
  runtimeHash?: string;
}

function manifestEntry(
  manifest: RuntimeAssetsManifest,
  kind: "workflow" | "skill",
  id: string
) {
  return kind === "workflow" ? manifest.workflows[id] : manifest.skills[id];
}

function setManifestEntry(
  manifest: RuntimeAssetsManifest,
  kind: "workflow" | "skill",
  id: string,
  entry: RuntimeAssetsManifest["workflows"][string]
): void {
  if (kind === "workflow") {
    manifest.workflows[id] = entry;
  } else {
    manifest.skills[id] = entry;
  }
}

function recordUpgradeManifest(
  manifest: RuntimeAssetsManifest,
  kind: "workflow" | "skill",
  id: string,
  bundledHash: string,
  bundledBody: string,
  runtimeHash?: string,
  runtimeBody?: string | null
): void {
  const prior = manifestEntry(manifest, kind, id);
  const priorHash =
    prior?.bundledHash ??
    (runtimeHash && runtimeHash !== bundledHash ? runtimeHash : undefined);
  if (priorHash && priorHash !== bundledHash) {
    recordBundledHashHistory(manifest, kind, id, priorHash);
  }
  const history = new Set(prior?.bundledHashHistory ?? []);
  if (priorHash) history.add(priorHash);
  const bundledBodyHistory = { ...(prior?.bundledBodyHistory ?? {}) };
  if (priorHash && prior?.bundledBody && prior.bundledHash === priorHash) {
    bundledBodyHistory[priorHash] = prior.bundledBody;
  }
  if (priorHash && runtimeBody && runtimeHash === priorHash) {
    bundledBodyHistory[priorHash] = runtimeBody;
  }
  const entry: RuntimeAssetsManifest["workflows"][string] = {
    bundledHash,
    bundledBody,
    updatedAt: now()
  };
  if (priorHash) entry.priorBundledHash = priorHash;
  const bundledHashHistory = [...history].sort();
  if (bundledHashHistory.length > 0) entry.bundledHashHistory = bundledHashHistory;
  if (Object.keys(bundledBodyHistory).length > 0) entry.bundledBodyHistory = bundledBodyHistory;
  setManifestEntry(manifest, kind, id, entry);
}

function recordNoopManifest(
  manifest: RuntimeAssetsManifest,
  kind: "workflow" | "skill",
  id: string,
  bundledHash: string,
  bundledBody: string
): boolean {
  const entry = manifestEntry(manifest, kind, id);
  if (entry?.kept) return false;
  if (entry?.bundledHash === bundledHash && entry.bundledBody === bundledBody) return false;
  setManifestEntry(manifest, kind, id, {
    ...(entry ?? {}),
    bundledHash,
    bundledBody,
    updatedAt: now()
  });
  return true;
}

function shouldReviewInsteadOfUpgrade(
  entry: RuntimeAssetsManifest["workflows"][string] | undefined
): boolean {
  return Boolean(entry?.pendingReview);
}

function missingManifestUpgrade(
  manifest: RuntimeAssetsManifest,
  kind: "workflow" | "skill",
  id: string,
  runtimeHash: string
): "upgrade" | "review" {
  return knownBundledHashes(manifest, kind, id).includes(runtimeHash) ? "upgrade" : "review";
}

async function decideWorkflowMigration(
  root: string,
  workflowId: string,
  manifest: RuntimeAssetsManifest
): Promise<AssetDecision> {
  const bundledHash = await readBundledWorkflowHash(workflowId);
  const runtimeText = await readRuntimeWorkflowText(root, workflowId);
  if (!runtimeText) {
    return { action: "install", bundledHash };
  }
  const runtimeHash = await workflowBundledHash(runtimeText);
  if (runtimeHash === bundledHash) {
    return { action: "noop", bundledHash, runtimeHash };
  }
  const entry = manifest.workflows[workflowId];
  const installedHash = entry?.bundledHash;
  if (!installedHash) {
    if (runtimeHash && missingManifestUpgrade(manifest, "workflow", workflowId, runtimeHash) === "upgrade") {
      return { action: "upgrade", bundledHash, runtimeHash };
    }
    return { action: "review", bundledHash, runtimeHash };
  }
  if (runtimeHash === installedHash) {
    if (entry?.kept) {
      return { action: "noop", bundledHash, runtimeHash };
    }
    if (shouldReviewInsteadOfUpgrade(entry)) {
      return { action: "review", bundledHash, runtimeHash };
    }
    return { action: "upgrade", bundledHash, runtimeHash };
  }
  return { action: "review", bundledHash, runtimeHash };
}

async function decideSkillMigration(
  root: string,
  skillId: string,
  manifest: RuntimeAssetsManifest
): Promise<AssetDecision | null> {
  const bundledBody = await readBundledSkillBody(skillId);
  if (!bundledBody) return null;
  const bundledHash = bundledSkillHash(bundledBody);
  const runtimeBody = await readRuntimeSkillBody(root, skillId);
  if (!runtimeBody) {
    return { action: "install", bundledHash };
  }
  const runtimeHash = bundledSkillHash(runtimeBody);
  if (runtimeHash === bundledHash) {
    return { action: "noop", bundledHash, runtimeHash };
  }
  const entry = manifest.skills[skillId];
  const installedHash = entry?.bundledHash;
  if (!installedHash) {
    if (runtimeHash && missingManifestUpgrade(manifest, "skill", skillId, runtimeHash) === "upgrade") {
      return { action: "upgrade", bundledHash, runtimeHash };
    }
    return { action: "review", bundledHash, runtimeHash };
  }
  if (runtimeHash === installedHash) {
    if (entry?.kept) {
      return { action: "noop", bundledHash, runtimeHash };
    }
    if (shouldReviewInsteadOfUpgrade(entry)) {
      return { action: "review", bundledHash, runtimeHash };
    }
    return { action: "upgrade", bundledHash, runtimeHash };
  }
  return { action: "review", bundledHash, runtimeHash };
}

export async function inspectRuntimeAssets(root: string): Promise<RuntimeAssetMigrationResult> {
  const manifest = await readRuntimeAssetsManifest(root);
  const result: RuntimeAssetMigrationResult = {
    upgraded: { workflows: [], skills: [] },
    pendingReview: { workflows: [], skills: [] },
    untouched: { workflows: [], skills: [] },
    errors: []
  };

  for (const workflowId of listBundledWorkflowIds()) {
    try {
      const decision = await decideWorkflowMigration(root, workflowId, manifest);
      if (decision.action === "install" || decision.action === "upgrade") {
        result.upgraded.workflows.push(workflowId);
      } else if (decision.action === "review") {
        result.pendingReview.workflows.push(workflowId);
      }
    } catch (error) {
      result.errors.push({
        kind: "workflow",
        id: workflowId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const skillId of bundledSkillIds()) {
    try {
      const decision = await decideSkillMigration(root, skillId, manifest);
      if (!decision) continue;
      if (decision.action === "install" || decision.action === "upgrade") {
        result.upgraded.skills.push(skillId);
      } else if (decision.action === "review") {
        result.pendingReview.skills.push(skillId);
      }
    } catch (error) {
      result.errors.push({
        kind: "skill",
        id: skillId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const bundledWorkflowSet = new Set<string>(listBundledWorkflowIds());
  const bundledSkillSet = new Set(bundledSkillIds());
  for (const workflowId of await listRuntimeWorkflowIds(root)) {
    if (!bundledWorkflowSet.has(workflowId)) {
      result.untouched.workflows.push(workflowId);
    }
  }
  for (const skillId of await listRuntimeSkillIds(root)) {
    if (!bundledSkillSet.has(skillId)) {
      result.untouched.skills.push(skillId);
    }
  }

  result.upgraded.workflows = sortUnique(result.upgraded.workflows);
  result.upgraded.skills = sortUnique(result.upgraded.skills);
  result.pendingReview.workflows = sortUnique(result.pendingReview.workflows);
  result.pendingReview.skills = sortUnique(result.pendingReview.skills);
  result.untouched.workflows = sortUnique(result.untouched.workflows);
  result.untouched.skills = sortUnique(result.untouched.skills);

  return result;
}

export async function migrateRuntimeAssets(root: string): Promise<RuntimeAssetMigrationResult> {
  const manifest = await readRuntimeAssetsManifest(root);
  const result: RuntimeAssetMigrationResult = {
    upgraded: { workflows: [], skills: [] },
    pendingReview: { workflows: [], skills: [] },
    untouched: { workflows: [], skills: [] },
    errors: []
  };
  let manifestChanged = false;

  for (const workflowId of listBundledWorkflowIds()) {
    try {
      const decision = await decideWorkflowMigration(root, workflowId, manifest);
      if (decision.action === "install" || decision.action === "upgrade") {
        const runtimeBody = await readRuntimeWorkflowText(root, workflowId);
        const bundledText = await readBundledWorkflowText(workflowId);
        await writeRuntimeWorkflow(root, workflowId, bundledText);
        recordUpgradeManifest(
          manifest,
          "workflow",
          workflowId,
          decision.bundledHash,
          bundledText,
          decision.runtimeHash,
          runtimeBody
        );
        manifestChanged = true;
        result.upgraded.workflows.push(workflowId);
      } else if (decision.action === "review") {
        result.pendingReview.workflows.push(workflowId);
        if (!manifest.workflows[workflowId]?.bundledHash && decision.runtimeHash) {
          manifest.workflows[workflowId] = {
            bundledHash: decision.runtimeHash,
            updatedAt: now(),
            pendingReview: true
          };
          manifestChanged = true;
        }
      } else if (recordNoopManifest(manifest, "workflow", workflowId, decision.bundledHash, await readBundledWorkflowText(workflowId))) {
        manifestChanged = true;
      }
    } catch (error) {
      result.errors.push({
        kind: "workflow",
        id: workflowId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const skillId of bundledSkillIds()) {
    try {
      const decision = await decideSkillMigration(root, skillId, manifest);
      if (!decision) continue;
      if (decision.action === "install" || decision.action === "upgrade") {
        const runtimeBody = await readRuntimeSkillBody(root, skillId);
        const bundledBody = (await readBundledSkillBody(skillId))!;
        await writeRuntimeSkill(root, skillId, bundledBody);
        recordUpgradeManifest(
          manifest,
          "skill",
          skillId,
          decision.bundledHash,
          bundledBody,
          decision.runtimeHash,
          runtimeBody
        );
        manifestChanged = true;
        result.upgraded.skills.push(skillId);
      } else if (decision.action === "review") {
        result.pendingReview.skills.push(skillId);
        if (!manifest.skills[skillId]?.bundledHash && decision.runtimeHash) {
          manifest.skills[skillId] = {
            bundledHash: decision.runtimeHash,
            updatedAt: now(),
            pendingReview: true
          };
          manifestChanged = true;
        }
      } else if (recordNoopManifest(
        manifest,
        "skill",
        skillId,
        decision.bundledHash,
        (await readBundledSkillBody(skillId))!
      )) {
        manifestChanged = true;
      }
    } catch (error) {
      result.errors.push({
        kind: "skill",
        id: skillId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const bundledWorkflowSet = new Set<string>(listBundledWorkflowIds());
  const bundledSkillSet = new Set(bundledSkillIds());
  for (const workflowId of await listRuntimeWorkflowIds(root)) {
    if (!bundledWorkflowSet.has(workflowId)) {
      result.untouched.workflows.push(workflowId);
    }
  }
  for (const skillId of await listRuntimeSkillIds(root)) {
    if (!bundledSkillSet.has(skillId)) {
      result.untouched.skills.push(skillId);
    }
  }

  if (manifestChanged) {
    await writeRuntimeAssetsManifest(root, manifest);
    resetWorkflowCache();
  }

  result.upgraded.workflows = sortUnique(result.upgraded.workflows);
  result.upgraded.skills = sortUnique(result.upgraded.skills);
  result.pendingReview.workflows = sortUnique(result.pendingReview.workflows);
  result.pendingReview.skills = sortUnique(result.pendingReview.skills);
  result.untouched.workflows = sortUnique(result.untouched.workflows);
  result.untouched.skills = sortUnique(result.untouched.skills);

  return result;
}
