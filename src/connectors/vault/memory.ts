import type { ConnectorTokenPayload } from "../../core/types.ts";
import type { ConnectorVault } from "./types.ts";

export class MemoryConnectorVault implements ConnectorVault {
  private readonly tokens = new Map<string, ConnectorTokenPayload>();

  async get(connectionId: string): Promise<ConnectorTokenPayload | null> {
    return this.tokens.get(connectionId) ?? null;
  }

  async set(connectionId: string, token: ConnectorTokenPayload): Promise<void> {
    this.tokens.set(connectionId, { ...token });
  }

  async delete(connectionId: string): Promise<void> {
    this.tokens.delete(connectionId);
  }
}