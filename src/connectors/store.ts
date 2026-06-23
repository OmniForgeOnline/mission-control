import path from "node:path";

import { readJsonFile, writeJsonFile } from "../core/infra/fs.ts";
import type { ConnectorAuthMethod, ConnectorConnection, ConnectorConnectionConfig } from "../core/types.ts";

function normalizeAuthMethod(connection: ConnectorConnection): ConnectorAuthMethod {
  return connection.authMethod ?? "token";
}

function normalizeConnection(connection: ConnectorConnection): ConnectorConnection {
  return {
    ...connection,
    authMethod: normalizeAuthMethod(connection)
  };
}

interface ConnectorsFile {
  connections: ConnectorConnection[];
}

function connectorsPath(root: string): string {
  return path.join(root, "data", "state", "connectors.json");
}

export async function listConnections(root: string): Promise<ConnectorConnection[]> {
  const file = await readJsonFile<ConnectorsFile>(connectorsPath(root), { connections: [] });
  return file.connections.map(normalizeConnection);
}

export async function getConnection(root: string, connectionId: string): Promise<ConnectorConnection | null> {
  const connections = await listConnections(root);
  return connections.find((connection) => connection.id === connectionId) ?? null;
}

export async function saveConnection(root: string, connection: ConnectorConnection): Promise<ConnectorConnection> {
  const connections = await listConnections(root);
  const index = connections.findIndex((entry) => entry.id === connection.id);
  if (index >= 0) {
    connections[index] = connection;
  } else {
    connections.push(connection);
  }
  await writeJsonFile(connectorsPath(root), { connections });
  return connection;
}

export async function deleteConnection(root: string, connectionId: string): Promise<boolean> {
  const connections = await listConnections(root);
  const next = connections.filter((connection) => connection.id !== connectionId);
  if (next.length === connections.length) {
    return false;
  }
  await writeJsonFile(connectorsPath(root), { connections: next });
  return true;
}

export async function updateConnectionConfig(
  root: string,
  connectionId: string,
  config: ConnectorConnectionConfig
): Promise<ConnectorConnection> {
  const connection = await getConnection(root, connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }
  return saveConnection(root, {
    ...connection,
    config: {
      ...connection.config,
      ...config
    }
  });
}

export async function findConnectionByProvider(
  root: string,
  providerId: ConnectorConnection["providerId"]
): Promise<ConnectorConnection | null> {
  const connections = await listConnections(root);
  return (
    connections.find((connection) => connection.providerId === providerId && connection.status === "connected") ??
    null
  );
}