export type RuntimeAssetKind = "workflow" | "skill";

export interface RuntimeAssetManifestEntry {
  bundledHash: string;
  updatedAt: string;
  /** Body corresponding to bundledHash; the common ancestor for the next upgrade. */
  bundledBody?: string;
  /** Last bundled hash before the most recent auto-upgrade. */
  priorBundledHash?: string;
  /** Known bundled hashes for three-way migration without a per-asset manifest entry. */
  bundledHashHistory?: string[];
  /** Recoverable bodies keyed by their bundled hash for historical diffs. */
  bundledBodyHistory?: Record<string, string>;
  /** Set when manifest hash was inferred from review; blocks auto-upgrade until keep/reset. */
  pendingReview?: boolean;
  /** Set by keepRuntimeAsset; blocks auto-upgrade until reset. */
  kept?: boolean;
}

export interface RuntimeAssetsHashHistory {
  workflows: Record<string, string[]>;
  skills: Record<string, string[]>;
}

export interface RuntimeAssetsManifest {
  schemaVersion: 1;
  workflows: Record<string, RuntimeAssetManifestEntry>;
  skills: Record<string, RuntimeAssetManifestEntry>;
  /** Global bundled-hash history that survives missing per-asset manifest rows. */
  hashHistory?: RuntimeAssetsHashHistory;
}

export interface RuntimeAssetMigrationResult {
  upgraded: { workflows: string[]; skills: string[] };
  pendingReview: { workflows: string[]; skills: string[] };
  untouched: { workflows: string[]; skills: string[] };
  errors: Array<{ kind: RuntimeAssetKind; id: string; message: string }>;
}

export interface RuntimeAssetDiff {
  kind: RuntimeAssetKind;
  id: string;
  status: "unchanged" | "runtime-customized" | "bundled-only" | "runtime-only";
  bundledBody: string | null;
  runtimeBody: string | null;
  priorBundledBody: string | null;
  bundledHash: string | null;
  runtimeHash: string | null;
  priorBundledHash: string | null;
  installedBundledHash: string | null;
}

export interface RuntimeAssetResetResult {
  kind: RuntimeAssetKind;
  id: string;
  backupPath: string;
}
