import type { RuntimeAssetKind, RuntimeAssetsManifest } from "./types.ts";

// Released v0.8.0 assets. Append hashes when a released bundled asset changes;
// this is the trust anchor for installs created before the manifest existed.
const RELEASED_BUNDLED_HASHES: Record<RuntimeAssetKind, Record<string, string[]>> = {
  workflow: {
    "blog-post": ["7598b5d41cd6b03ceef3208ab517e7d80332e33cb8d36d550619a435d28608ce"],
    bugfix: ["618a5cade4547ad22b03336ecfe3a7d4e38920f60a148aa0a5e30ce60e7302d4"],
    "code-feature": ["e96d9825166178f4c9fad73a719d39224e505d632d8cdca8450f47a4a64f3bdc"],
    "customer-support": ["7bbc982d62a80c98e6ad46d6cfaef46509ab3767b4d7ddbc9fcfd8fd07743b0a"],
    "data-analysis": ["5654253787e1804ed5fa0adc3ab6f202a3eba046ae6b46f05962d491fdbfbe34"],
    "docs-update": ["5bfb9c1414495000072e9d32f672351efe739f4175fada5714d0891f6d7b3a3e"],
    "frontend-ui-change": ["1d0c836346558f5e37ec22401d5f88e697a1b1ccec1d82148b991dfd904aa86b"],
    "incident-response": ["e485b35e16e03fb9476e14ecbb6c7b05b9a3be10359e0bafac67b754688cd3d7"],
    "infrastructure-change": ["dfaf5f6342b5743a76334dff6f5d5b19672bf39c2bf722c1f7bc27d0c17999cf"],
    "product-spec": ["de9481774f021412444f98c777ffcc9e7cf309e01ea14a7a235d715f887dd5ad"],
    "seo-investigation": ["60a33d1b0d3e25b65ee9bb23b1016d32e99e1dd8732319a7d7ec8eac4aec77a1"],
    "technical-debt": ["2f0665b873f733f188da4c47205e4f2d9c1321718ebe9a717feca55de1612899"],
    "write-document": ["fbe61999d45a09814b389e0f9b38881c5140d8f95098f80f8a2a7c7ac3729c28"]
  },
  skill: {
    "harness-turn-loop": ["6057c838e26bdf8720de6b90355bb92bea223641468c3d08141e8ceecf77d5a5"]
  }
};

function historyBucket(
  manifest: RuntimeAssetsManifest,
  kind: RuntimeAssetKind
): Record<string, string[]> {
  if (!manifest.hashHistory) {
    manifest.hashHistory = { workflows: {}, skills: {} };
  }
  return kind === "workflow" ? manifest.hashHistory.workflows : manifest.hashHistory.skills;
}

export function knownBundledHashes(
  manifest: RuntimeAssetsManifest,
  kind: RuntimeAssetKind,
  id: string
): string[] {
  const entry =
    kind === "workflow" ? manifest.workflows[id] : manifest.skills[id];
  const global = historyBucket(manifest, kind)[id] ?? [];
  const local = entry?.bundledHashHistory ?? [];
  const released = RELEASED_BUNDLED_HASHES[kind][id] ?? [];
  const hashes = new Set<string>([...released, ...global, ...local]);
  if (entry?.bundledHash) hashes.add(entry.bundledHash);
  if (entry?.priorBundledHash) hashes.add(entry.priorBundledHash);
  return [...hashes];
}

export function recordBundledHashHistory(
  manifest: RuntimeAssetsManifest,
  kind: RuntimeAssetKind,
  id: string,
  hash: string
): void {
  const bucket = historyBucket(manifest, kind);
  const next = new Set(bucket[id] ?? []);
  next.add(hash);
  bucket[id] = [...next].sort();
}
