import type express from "express";

import type { ConnectorProviderId } from "../../core/types.ts";
import type { EditorSpawner } from "../../core/editors/launch.ts";
import type { ConnectorVault } from "../../connectors/vault/index.ts";
import type { AgentRunner } from "../../runners/types.ts";

export interface ServerOptions {
  root: string;
  /** Optional pre-built runner used by tests to inject a deterministic agent. */
  runner?: AgentRunner;
  /** Test-only mode: avoids shell/provider probes and waits for async handlers. */
  testMode?: boolean;
  staticDir?: string;
  homeRoot?: string;
  vault?: ConnectorVault;
  /**
   * Unguessable token a caller must present in the x-shutdown-token header to
   * trigger /api/shutdown. When absent, createServer generates one and exposes
   * it via /api/state boot state. Production sets it explicitly so the same
   * value lands in server.json for the CLI.
   */
  shutdownToken?: string;
  /** Optional editor launcher used by tests to avoid spawning real desktop apps. */
  editorSpawner?: EditorSpawner;
  /** Installed package root (where package.json + dist/ live). Drives version
   * detection and the self-update flow. Defaults to a derivation from this
   * module's location, which the server entry sets explicitly. */
  packageRoot?: string;
  /** Test injection for the detached updater spawn (avoids real process exit). */
  updateSpawn?: (script: string, env: NodeJS.ProcessEnv) => boolean;
  /** Test injection for the post-apply process exit (avoids real process exit). */
  updateExit?: () => void;
}

export function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function param(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return value;
}

/** Coerce an unknown request body value into a non-empty string array, or
 * undefined. Used to normalize attachment id lists coming from the client. */
export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return ids.length > 0 ? ids : undefined;
}

const CONNECTOR_PROVIDER_IDS = new Set<ConnectorProviderId>(["github", "gitlab", "clickup"]);

export function asConnectorProviderId(value: string): ConnectorProviderId {
  if (!CONNECTOR_PROVIDER_IDS.has(value as ConnectorProviderId)) {
    throw new Error(`Unknown connector provider: ${value}`);
  }
  return value as ConnectorProviderId;
}

export function turnOptions(options: ServerOptions) {
  return {
    ...(options.runner ? { runner: options.runner } : {}),
    wait: options.testMode === true
  };
}

export function connectorVaultOptions(options: ServerOptions) {
  return options.vault ? { vault: options.vault } : {};
}
