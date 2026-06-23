import { DEFAULT_HARNESS_ROOT } from "../../core/bootstrap/repository.ts";
import { FileConnectorVault } from "./file.ts";
import { KeychainConnectorVault } from "./keychain.ts";
import { MemoryConnectorVault } from "./memory.ts";
import type { ConnectorVault } from "./types.ts";

export type VaultMode = "memory" | "keychain" | "file";

let singleton: ConnectorVault | null = null;

export interface ResolveModeInput {
  /** Explicit override (e.g. from constructor option or test). */
  readonly explicit?: VaultMode | undefined;
  /** Value of HARNESS_VAULT; defaults to the live env var. */
  readonly envVault?: string | undefined;
  /** Platform to decide the default backend; defaults to the live platform. */
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * Pure backend resolution so platform/env behavior is unit-testable without
 * mutating globals. Precedence: explicit > HARNESS_VAULT > platform default
 * (keychain on macOS, file elsewhere).
 */
export function resolveVaultMode(input: ResolveModeInput = {}): VaultMode {
  if (input.explicit) return input.explicit;
  const envVault = input.envVault ?? process.env["HARNESS_VAULT"];
  if (envVault === "memory" || envVault === "keychain" || envVault === "file") {
    return envVault;
  }
  const platform = input.platform ?? process.platform;
  return platform === "darwin" ? "keychain" : "file";
}

export interface CreateVaultOptions {
  readonly mode?: VaultMode | undefined;
  readonly root?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function createConnectorVault(options: CreateVaultOptions = {}): ConnectorVault {
  const mode = resolveVaultMode({
    explicit: options.mode,
    platform: options.platform
  });
  switch (mode) {
    case "memory":
      return new MemoryConnectorVault();
    case "file":
      return new FileConnectorVault(options.root ?? process.env["HARNESS_ROOT"] ?? DEFAULT_HARNESS_ROOT);
    case "keychain":
    default:
      return new KeychainConnectorVault();
  }
}

/**
 * Returns the process-wide connector vault, creating it lazily. Pass the harness
 * `root` on the first call (e.g. at server boot) so a file backend lands in the
 * right place; subsequent calls ignore the argument.
 */
export function getConnectorVault(root?: string): ConnectorVault {
  if (!singleton) {
    singleton = createConnectorVault({ root });
  }
  return singleton;
}

export function setConnectorVault(vault: ConnectorVault): void {
  singleton = vault;
}

export type { ConnectorVault } from "./types.ts";
