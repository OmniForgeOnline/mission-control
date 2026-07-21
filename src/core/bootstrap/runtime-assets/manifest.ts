import path from "node:path";

import { readJsonFile, writeJsonFile } from "../../infra/fs.ts";
import type { RuntimeAssetsManifest } from "./types.ts";

export function runtimeAssetsManifestPath(root: string): string {
  return path.join(root, "data", "state", "runtime-assets-manifest.json");
}

export function emptyRuntimeAssetsManifest(): RuntimeAssetsManifest {
  return { schemaVersion: 1, workflows: {}, skills: {}, hashHistory: { workflows: {}, skills: {} } };
}

export async function readRuntimeAssetsManifest(root: string): Promise<RuntimeAssetsManifest> {
  const stored = await readJsonFile<Partial<RuntimeAssetsManifest> | null>(
    runtimeAssetsManifestPath(root),
    null
  );
  if (!stored || stored.schemaVersion !== 1) {
    return emptyRuntimeAssetsManifest();
  }
  return {
    schemaVersion: 1,
    workflows: stored.workflows ?? {},
    skills: stored.skills ?? {},
    hashHistory: {
      workflows: stored.hashHistory?.workflows ?? {},
      skills: stored.hashHistory?.skills ?? {}
    }
  };
}

export async function writeRuntimeAssetsManifest(
  root: string,
  manifest: RuntimeAssetsManifest
): Promise<void> {
  await writeJsonFile(runtimeAssetsManifestPath(root), manifest);
}
