import type { ConnectorTokenPayload } from "../../core/types.ts";

export interface ConnectorVault {
  get(connectionId: string): Promise<ConnectorTokenPayload | null>;
  set(connectionId: string, token: ConnectorTokenPayload): Promise<void>;
  delete(connectionId: string): Promise<void>;
}