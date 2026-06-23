import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConnectorTokenPayload } from "../../core/types.ts";
import type { ConnectorVault } from "./types.ts";

const execFileAsync = promisify(execFile);
const SERVICE = "personal-agent-harness";

function accountFor(connectionId: string): string {
  return `connection:${connectionId}`;
}

function serializeToken(token: ConnectorTokenPayload): string {
  return JSON.stringify(token);
}

function parseToken(raw: string): ConnectorTokenPayload | null {
  try {
    const parsed = JSON.parse(raw) as ConnectorTokenPayload;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class KeychainConnectorVault implements ConnectorVault {
  async get(connectionId: string): Promise<ConnectorTokenPayload | null> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        accountFor(connectionId),
        "-s",
        SERVICE,
        "-w"
      ]);
      return parseToken(stdout.trim());
    } catch {
      return null;
    }
  }

  async set(connectionId: string, token: ConnectorTokenPayload): Promise<void> {
    const args = [
      "add-generic-password",
      "-U",
      "-a",
      accountFor(connectionId),
      "-s",
      SERVICE,
      "-w",
      serializeToken(token)
    ];
    await execFileAsync("security", args);
  }

  async delete(connectionId: string): Promise<void> {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-a",
        accountFor(connectionId),
        "-s",
        SERVICE
      ]);
    } catch {
      // Missing entries are fine during disconnect.
    }
  }
}