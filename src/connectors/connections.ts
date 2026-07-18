import { getGhToken, isGhAuthenticated } from "./auth/gh-cli.ts";
import { CONNECTOR_PROVIDERS } from "./registry.ts";
import {
  deleteConnection,
  findConnectionByProvider,
  getConnection,
  listConnections,
  saveConnection,
  updateConnectionConfig
} from "./store.ts";
import { getConnectorVault, type ConnectorVault } from "./vault/index.ts";
import { fetchClickUpAccount, fetchClickUpResources, importClickUpTasks } from "./providers/clickup.ts";
import { fetchGithubAccount, fetchGithubResources, importGithubIssues } from "./providers/github.ts";
import { fetchGitlabAccount, fetchGitlabResources, importGitlabIssues } from "./providers/gitlab.ts";
import { setAutonomyJobStatus } from "../autonomy/jobs.ts";
import { loadHarnessSettings } from "../core/settings.ts";
import type {
  ConnectorAuthMethod,
  ConnectorConnection,
  ConnectorConnectionConfig,
  ConnectorProviderId,
  ConnectorResourceOption,
  ConnectorsState,
  CreateTaskInput
} from "../core/types.ts";

type FetchLike = typeof fetch;

const CLICKUP_TICKET_SYNC_JOB_ID = "clickup-ticket-sync";

async function setClickUpTicketSyncStatus(root: string, status: "active" | "paused"): Promise<void> {
  try {
    await setAutonomyJobStatus(root, CLICKUP_TICKET_SYNC_JOB_ID, status);
  } catch {
    // Best-effort: disconnect/connect must not fail if the job store is unavailable.
  }
}

async function resolveAccountLabel(
  providerId: ConnectorProviderId,
  token: string,
  fetchImpl: FetchLike
): Promise<string> {
  if (providerId === "github") {
    return (await fetchGithubAccount(token, fetchImpl)).accountLabel;
  }
  if (providerId === "gitlab") {
    return (await fetchGitlabAccount(token, fetchImpl)).accountLabel;
  }
  return (await fetchClickUpAccount(token, fetchImpl)).accountLabel;
}

async function upsertProviderConnection(
  root: string,
  input: {
    providerId: ConnectorProviderId;
    authMethod: ConnectorAuthMethod;
    accountLabel: string;
    status?: ConnectorConnection["status"];
    lastError?: string;
  }
): Promise<ConnectorConnection> {
  const existing = await findConnectionByProvider(root, input.providerId);
  return saveConnection(root, {
    id: existing?.id ?? crypto.randomUUID(),
    providerId: input.providerId,
    status: input.status ?? "connected",
    authMethod: input.authMethod,
    accountLabel: input.accountLabel,
    connectedAt: new Date().toISOString(),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    config: existing?.config ?? {}
  });
}

export async function loadConnectorsState(root: string): Promise<ConnectorsState> {
  const ghCliAvailable = await isGhAuthenticated();
  const providers = CONNECTOR_PROVIDERS.map((provider) =>
    provider.id === "github" ? { ...provider, ghCliAvailable } : { ...provider }
  );
  return {
    providers,
    connections: await listConnections(root)
  };
}

export async function connectWithToken(
  root: string,
  providerId: ConnectorProviderId,
  token: string,
  options?: { fetchImpl?: FetchLike; vault?: ConnectorVault }
): Promise<ConnectorConnection> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Token is required.");
  }
  const vault = options?.vault ?? getConnectorVault();
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const accountLabel = await resolveAccountLabel(providerId, trimmed, fetchImpl);
    const connection = await upsertProviderConnection(root, {
      providerId,
      authMethod: "token",
      accountLabel
    });
    await vault.set(connection.id, { accessToken: trimmed });
    if (providerId === "clickup") {
      await setClickUpTicketSyncStatus(root, "active");
    }
    return connection;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to validate token";
    await upsertProviderConnection(root, {
      providerId,
      authMethod: "token",
      accountLabel: "Invalid token",
      status: "error",
      lastError: message
    });
    throw new Error(message);
  }
}

export async function connectWithGhCli(
  root: string,
  options?: { fetchImpl?: FetchLike; vault?: ConnectorVault }
): Promise<ConnectorConnection> {
  const vault = options?.vault ?? getConnectorVault();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const token = await getGhToken();
  const accountLabel = await resolveAccountLabel("github", token, fetchImpl);
  const connection = await upsertProviderConnection(root, {
    providerId: "github",
    authMethod: "gh_cli",
    accountLabel
  });
  await vault.delete(connection.id);
  return connection;
}

export async function disconnectConnector(
  root: string,
  connectionId: string,
  options?: { vault?: ConnectorVault }
): Promise<boolean> {
  const vault = options?.vault ?? getConnectorVault();
  const connection = await getConnection(root, connectionId);
  if (!connection) {
    return false;
  }
  if (connection.providerId === "clickup") {
    await setClickUpTicketSyncStatus(root, "paused");
  }
  await vault.delete(connectionId);
  return deleteConnection(root, connectionId);
}

export async function getProviderAccessToken(
  root: string,
  providerId: ConnectorProviderId,
  options?: { vault?: ConnectorVault }
): Promise<string | null> {
  const connection = await findConnectionByProvider(root, providerId);
  if (!connection || connection.status !== "connected") {
    return null;
  }
  return getConnectorAccessToken(connection.id, {
    root,
    ...(options?.vault ? { vault: options.vault } : {})
  });
}

async function getConnectorAccessToken(
  connectionId: string,
  options?: { root?: string; vault?: ConnectorVault }
): Promise<string | null> {
  if (!options?.root) {
    throw new Error("Connection root is required to resolve access tokens.");
  }
  const connection = await getConnection(options.root, connectionId);
  if (!connection || connection.status !== "connected") {
    return null;
  }
  if (connection.authMethod === "gh_cli") {
    return getGhToken();
  }

  const vault = options?.vault ?? getConnectorVault();
  const token = await vault.get(connectionId);
  return token?.accessToken ?? null;
}

export async function patchConnectorConfig(
  root: string,
  connectionId: string,
  config: ConnectorConnectionConfig
): Promise<ConnectorConnection> {
  return updateConnectionConfig(root, connectionId, config);
}

export async function listConnectorResources(
  root: string,
  connectionId: string,
  options?: { fetchImpl?: FetchLike; vault?: ConnectorVault; refresh?: boolean }
): Promise<ConnectorResourceOption[]> {
  const connection = await getConnection(root, connectionId);
  if (!connection || connection.status !== "connected") {
    throw new Error(`Connection not available: ${connectionId}`);
  }
  const token = await getConnectorAccessToken(connectionId, {
    root,
    ...(options?.vault ? { vault: options.vault } : {})
  });
  if (!token) {
    throw new Error(`Missing token for connection: ${connectionId}`);
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (connection.providerId === "github") {
    return fetchGithubResources(token, fetchImpl);
  }
  if (connection.providerId === "gitlab") {
    return fetchGitlabResources(token, fetchImpl);
  }
  if (!options?.refresh && connection.config.clickup?.cachedResources) {
    return connection.config.clickup.cachedResources;
  }
  const resources = await fetchClickUpResources(token, connection.config.clickup?.teamId, fetchImpl);
  await updateConnectionConfig(root, connectionId, {
    clickup: {
      ...(connection.config.clickup ?? {}),
      cachedResources: resources,
      resourcesSyncedAt: new Date().toISOString()
    }
  });
  return resources;
}

export async function importConnectorTasks(
  root: string,
  connectionId: string,
  options?: { fetchImpl?: FetchLike; vault?: ConnectorVault }
): Promise<CreateTaskInput[]> {
  const connection = await getConnection(root, connectionId);
  if (!connection || connection.status !== "connected") {
    throw new Error(`Connection not available: ${connectionId}`);
  }
  const token = await getConnectorAccessToken(connectionId, {
    root,
    ...(options?.vault ? { vault: options.vault } : {})
  });
  if (!token) {
    throw new Error(`Missing token for connection: ${connectionId}`);
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  const settings = await loadHarnessSettings(root);
  if (connection.providerId === "github") {
    return importGithubIssues({
      token,
      projectsRoot: settings.projectsRoot,
      fetchImpl
    });
  }
  if (connection.providerId === "gitlab") {
    return importGitlabIssues({
      token,
      projectsRoot: settings.projectsRoot,
      fetchImpl
    });
  }
  return importClickUpTasks({
    token,
    fetchImpl,
    ...(connection.config.clickup?.listId ? { listId: connection.config.clickup.listId } : {})
  });
}
