import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../../infra/fs.ts";
import { resetWorkflowCache } from "../../workflows/cache.ts";
import { workflowsDir } from "../../workflows/paths.ts";
import {
  bundledSkillHash,
  readBundledSkillBody,
  readBundledSkillHash,
  readBundledWorkflowHash,
  readBundledWorkflowText,
  workflowBundledHash
} from "./bundled.ts";
import { readRuntimeAssetsManifest, writeRuntimeAssetsManifest } from "./manifest.ts";
import type {
  RuntimeAssetDiff,
  RuntimeAssetKind,
  RuntimeAssetManifestEntry,
  RuntimeAssetResetResult
} from "./types.ts";

function installedBundledAncestor(
  entry: RuntimeAssetManifestEntry | undefined,
  currentBundledHash: string | null
): string | null {
  if (!entry) return null;
  return entry.bundledHash && entry.bundledHash !== currentBundledHash
    ? entry.bundledHash
    : entry.priorBundledHash ?? null;
}

function bodyForInstalledAncestor(
  entry: RuntimeAssetManifestEntry | undefined,
  ancestorHash: string | null
): string | null {
  if (!entry || !ancestorHash) return null;
  if (ancestorHash === entry.bundledHash) return entry.bundledBody ?? entry.bundledBodyHistory?.[ancestorHash] ?? null;
  return entry.bundledBodyHistory?.[ancestorHash] ?? null;
}

function resolvePriorBundledBody(
  priorBundledHash: string | null,
  bundledBody: string | null,
  runtimeBody: string | null,
  bundledHash: string | null,
  runtimeHash: string | null,
  installedBundledHash: string | null,
  bundledBodyHistory: Record<string, string> | undefined
): string | null {
  if (!priorBundledHash) return null;
  const historicalBody = bundledBodyHistory?.[priorBundledHash];
  if (historicalBody) return historicalBody;
  if (priorBundledHash === runtimeHash) return runtimeBody;
  if (priorBundledHash === bundledHash) return bundledBody;
  if (priorBundledHash === installedBundledHash && installedBundledHash === runtimeHash) {
    return runtimeBody;
  }
  return null;
}

function now(): string {
  return new Date().toISOString();
}

export function runtimeAssetBackupDir(root: string): string {
  return path.join(root, "data", "state", "runtime-asset-backups");
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

export async function diffRuntimeAsset(
  root: string,
  kind: RuntimeAssetKind,
  id: string
): Promise<RuntimeAssetDiff> {
  const manifest = await readRuntimeAssetsManifest(root);
  if (kind === "workflow") {
    const bundledBody = await readBundledWorkflowText(id).catch(() => null);
    const runtimeBody = await readRuntimeWorkflowText(root, id);
    const bundledHash = bundledBody ? await workflowBundledHash(bundledBody) : null;
    const runtimeHash = runtimeBody ? await workflowBundledHash(runtimeBody) : null;
    const entry = manifest.workflows[id];
    const installedBundledHash = entry?.bundledHash ?? null;
    const bundledBodyHistory = entry?.bundledBodyHistory;
    const priorBundledHash = installedBundledAncestor(entry, bundledHash);
    const installedBundledBody = bodyForInstalledAncestor(entry, priorBundledHash);
    let status: RuntimeAssetDiff["status"] = "runtime-only";
    if (bundledBody && runtimeBody) {
      status = bundledHash === runtimeHash ? "unchanged" : "runtime-customized";
    } else if (bundledBody) {
      status = "bundled-only";
    }
    return {
      kind,
      id,
      status,
      bundledBody,
      runtimeBody,
      priorBundledBody: installedBundledBody ?? resolvePriorBundledBody(
        priorBundledHash, bundledBody, runtimeBody, bundledHash, runtimeHash, installedBundledHash, bundledBodyHistory
      ),
      bundledHash,
      runtimeHash,
      priorBundledHash,
      installedBundledHash
    };
  }

  const bundledBody = await readBundledSkillBody(id);
  const runtimeBody = await readRuntimeSkillBody(root, id);
  const bundledHash = bundledBody ? bundledSkillHash(bundledBody) : null;
  const runtimeHash = runtimeBody ? bundledSkillHash(runtimeBody) : null;
  const entry = manifest.skills[id];
  const installedBundledHash = entry?.bundledHash ?? null;
  const bundledBodyHistory = entry?.bundledBodyHistory;
  const priorBundledHash = installedBundledAncestor(entry, bundledHash);
  const installedBundledBody = bodyForInstalledAncestor(entry, priorBundledHash);
  let status: RuntimeAssetDiff["status"] = "runtime-only";
  if (bundledBody && runtimeBody) {
    status = bundledHash === runtimeHash ? "unchanged" : "runtime-customized";
  } else if (bundledBody) {
    status = "bundled-only";
  }
  return {
    kind,
    id,
    status,
    bundledBody,
    runtimeBody,
    priorBundledBody: installedBundledBody ?? resolvePriorBundledBody(
      priorBundledHash, bundledBody, runtimeBody, bundledHash, runtimeHash, installedBundledHash, bundledBodyHistory
    ),
    bundledHash,
    runtimeHash,
    priorBundledHash,
    installedBundledHash
  };
}

export async function resetRuntimeAsset(
  root: string,
  kind: RuntimeAssetKind,
  id: string
): Promise<RuntimeAssetResetResult> {
  const diff = await diffRuntimeAsset(root, kind, id);
  if (!diff.bundledBody) {
    throw new Error(`No bundled ${kind} asset exists for "${id}".`);
  }
  if (!diff.runtimeBody) {
    throw new Error(`Runtime ${kind} "${id}" is not installed.`);
  }

  const backupDir = path.join(runtimeAssetBackupDir(root), kind, id);
  await ensureDir(backupDir);
  const backupPath = path.join(backupDir, `${Date.now()}.bak`);
  await writeFile(backupPath, diff.runtimeBody, "utf8");

  if (kind === "workflow") {
    const filePath = path.join(workflowsDir(root), `${id}.yml`);
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, diff.bundledBody, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.workflows[id] = {
      bundledHash: (await readBundledWorkflowHash(id))!,
      bundledBody: diff.bundledBody,
      updatedAt: now()
    };
    await writeRuntimeAssetsManifest(root, manifest);
    resetWorkflowCache();
  } else {
    const skillPath = path.join(root, "skills", id, "SKILL.md");
    await ensureDir(path.dirname(skillPath));
    await writeFile(skillPath, diff.bundledBody, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.skills[id] = {
      bundledHash: (await readBundledSkillHash(id))!,
      bundledBody: diff.bundledBody,
      updatedAt: now()
    };
    await writeRuntimeAssetsManifest(root, manifest);
  }

  return { kind, id, backupPath };
}

export async function keepRuntimeAsset(
  root: string,
  kind: RuntimeAssetKind,
  id: string
): Promise<{ kind: RuntimeAssetKind; id: string; bundledHash: string }> {
  const diff = await diffRuntimeAsset(root, kind, id);
  if (!diff.runtimeBody || !diff.runtimeHash) {
    throw new Error(`Runtime ${kind} "${id}" is not installed.`);
  }
  const manifest = await readRuntimeAssetsManifest(root);
  const entry = { bundledHash: diff.runtimeHash, bundledBody: diff.runtimeBody, updatedAt: now(), kept: true };
  if (kind === "workflow") {
    manifest.workflows[id] = entry;
  } else {
    manifest.skills[id] = entry;
  }
  await writeRuntimeAssetsManifest(root, manifest);
  return { kind, id, bundledHash: diff.runtimeHash };
}
