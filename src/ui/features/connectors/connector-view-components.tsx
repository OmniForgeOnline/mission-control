import type {
  ConnectorConnection,
  ConnectorProviderStatus,
  ConnectorResourceOption
} from "../../../core/types.ts";
import type { ProjectSummary } from "@ui/app/types.js";
import type { ComponentChildren } from "preact";
import { withPending } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ClickUpListControl } from "./clickup-list-control.js";
import { ClickUpTicketSyncPanel } from "./clickup-ticket-sync-panel.js";
import { ConnectPanel } from "./connector-connect-panel.js";
import { ConnectorLogo } from "./connector-logo.js";

export function connectionForProvider(
  connections: ConnectorConnection[],
  providerId: ConnectorProviderStatus["id"]
): ConnectorConnection | undefined {
  return connections.find((connection) => connection.providerId === providerId && connection.status !== "disconnected");
}

function authMethodLabel(method: ConnectorConnection["authMethod"]): string {
  if (method === "gh_cli") return "GitHub CLI";
  return "Personal token";
}

function relativeTime(iso?: string): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function subscribedListCount(connection?: ConnectorConnection): number {
  if (!connection) return 0;
  const ids = new Set([
    ...(connection.config.clickup?.subscribedListIds ?? []),
    ...(connection.config.clickup?.listId ? [connection.config.clickup.listId] : [])
  ]);
  return ids.size;
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function SpinningIcon({ name, size = 16, spinning = false }: { name: string; size?: number; spinning?: boolean }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size, spinning ? "icon icon-spin" : "icon") }} />;
}

function StatusBadge({ connection }: { connection?: ConnectorConnection }) {
  if (!connection) {
    return (
      <span class="catalog-badge is-off">
        <span class="catalog-badge-dot" />
        Not connected
      </span>
    );
  }
  if (connection.status === "error") {
    return (
      <span class="catalog-badge is-err">
        <span class="catalog-badge-dot" />
        Error
      </span>
    );
  }
  return (
    <span class="catalog-badge is-ok">
      <span class="catalog-badge-dot" />
      Connected
    </span>
  );
}

function CatalogItem({
  provider,
  connection,
  selected,
  onSelect
}: {
  provider: ConnectorProviderStatus;
  connection?: ConnectorConnection;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const connected = connection?.status === "connected";
  const errored = connection?.status === "error";
  const sub = connected || errored ? connection?.accountLabel ?? "Connected" : "Not connected";
  const statusClass = errored ? "is-err" : connected ? "is-ok" : "is-off";

  return (
    <button
      type="button"
      class={`catalog-item${selected ? " is-selected" : ""}${connection ? "" : " is-available"}`}
      data-provider-id={provider.id}
      aria-pressed={selected}
      onClick={() => onSelect(provider.id)}
    >
      <span class="catalog-item-logo">
        <ConnectorLogo providerId={provider.id} />
      </span>
      <span class="catalog-item-meta">
        <span class="catalog-item-name">{provider.displayName}</span>
        <span class="catalog-item-sub">{sub}</span>
      </span>
      {connection ? (
        <span class={`catalog-item-status ${statusClass}`} aria-hidden="true" />
      ) : (
        <span class="catalog-item-add">Add</span>
      )}
    </button>
  );
}

export function Catalog({
  providers,
  connections,
  selectedId,
  query,
  onQuery,
  onSelect
}: {
  providers: ConnectorProviderStatus[];
  connections: ConnectorConnection[];
  selectedId: string;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const matches = (provider: ConnectorProviderStatus) =>
    !q || provider.displayName.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q);

  const connected: ConnectorProviderStatus[] = [];
  const available: ConnectorProviderStatus[] = [];
  for (const provider of providers) {
    if (!matches(provider)) continue;
    if (connectionForProvider(connections, provider.id)) connected.push(provider);
    else available.push(provider);
  }

  return (
    <aside class="catalog-rail">
      <div class="catalog-search">
        <span class="catalog-search-ico" dangerouslySetInnerHTML={{ __html: icon("search", 14) }} />
        <input
          class="input"
          type="text"
          placeholder="Search connectors"
          autocomplete="off"
          value={query}
          onInput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
        />
      </div>

      {connected.length ? (
        <div class="catalog-group">
          <div class="catalog-group-head">
            Connected <span class="catalog-group-count">{connected.length}</span>
          </div>
          {connected.map((provider) => {
            const conn = connectionForProvider(connections, provider.id);
            return (
              <CatalogItem
                key={provider.id}
                provider={provider}
                {...(conn ? { connection: conn } : {})}
                selected={selectedId === provider.id}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      ) : null}

      {available.length ? (
        <div class="catalog-group">
          <div class="catalog-group-head">
            Available to add <span class="catalog-group-count">{available.length}</span>
          </div>
          {available.map((provider) => (
            <CatalogItem
              key={provider.id}
              provider={provider}
              selected={selectedId === provider.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      {!connected.length && !available.length ? (
        <p class="catalog-empty">No connectors match "{query}".</p>
      ) : null}
    </aside>
  );
}

function IdentityHeader({
  provider,
  connection,
  actions
}: {
  provider: ConnectorProviderStatus;
  connection?: ConnectorConnection;
  actions?: ComponentChildren;
}) {
  const account = connection
    ? connection.status === "error"
      ? `Connection error - ${connection.lastError ?? "reconnect to resume sync."}`
      : `Signed in as ${connection.accountLabel ?? "your account"} · ${authMethodLabel(connection.authMethod)} · connected ${relativeTime(connection.connectedAt)}`
    : `Not connected - add a personal access token to enable sync.`;

  return (
    <header class="catalog-id-head">
      <span class="catalog-id-logo">
        <ConnectorLogo providerId={provider.id} />
      </span>
      <div class="catalog-id-text">
        <div class="catalog-id-title-row">
          <h2 class="catalog-id-title">{provider.displayName}</h2>
          <StatusBadge {...(connection ? { connection } : {})} />
        </div>
        <p class="catalog-id-account">{account}</p>
      </div>
      {actions ? <div class="catalog-id-actions">{actions}</div> : null}
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="catalog-fact">
      <div class="catalog-fact-k">{label}</div>
      <div class="catalog-fact-v">{children}</div>
    </div>
  );
}

function AccountPanel({ provider, connection }: { provider: ConnectorProviderStatus; connection: ConnectorConnection }) {
  const scopes = connection.scopes ?? [];
  const isClickUp = provider.id === "clickup";
  return (
    <>
      <div class="catalog-section-label">Account</div>
      <section class="catalog-panel">
        <div class="catalog-panel-body catalog-panel-body-compact">
          <div class="catalog-facts">
            <Fact label={isClickUp ? "Workspace" : "Account"}>
              <span class={isClickUp ? "" : "catalog-fact-mono"}>{connection.accountLabel ?? "-"}</span>
            </Fact>
            <Fact label="Auth method">{authMethodLabel(connection.authMethod)}</Fact>
            {isClickUp ? (
              <Fact label="Lists synced">{relativeTime(connection.config.clickup?.resourcesSyncedAt)}</Fact>
            ) : (
              <Fact label="Token scopes">
                {scopes.length ? (
                  <div class="connector-chips">
                    {scopes.map((scope) => (
                      <span class="connector-chip" key={scope}>
                        {scope}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span class="catalog-fact-muted">-</span>
                )}
              </Fact>
            )}
            <Fact label="Connected">{relativeTime(connection.connectedAt)}</Fact>
          </div>
        </div>
      </section>
    </>
  );
}

function GitDetail({
  provider,
  connection,
  onImport
}: {
  provider: ConnectorProviderStatus;
  connection: ConnectorConnection;
  onImport: (connectionId: string) => void;
}) {
  return (
    <>
      <AccountPanel provider={provider} connection={connection} />
      <div class="catalog-section-label">Import</div>
      <section class="catalog-panel">
        <div class="catalog-panel-body">
          <div class="connector-action-zone">
            <div class="connector-action-text">
              <div class="connector-action-title">Import open issues</div>
              <p class="connector-action-desc">
                Import scans all accessible repos/projects and auto-binds open issues to local clones under your
                workspace root.
              </p>
            </div>
            <button
              class="btn btn-primary"
              type="button"
              data-import={connection.id}
              onClick={(event) =>
                void withPending(event.currentTarget as HTMLButtonElement, async () => {
                  await onImport(connection.id);
                })
              }
            >
              <Icon name="inbox" size={14} />
              <span>Import now</span>
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function ClickUpDetail({
  provider,
  connection,
  resources,
  projects,
  syncing,
  onSync,
  onImport,
  onListChange
}: {
  provider: ConnectorProviderStatus;
  connection: ConnectorConnection;
  resources: ConnectorResourceOption[];
  projects: ProjectSummary[];
  syncing: boolean;
  onSync: (connectionId: string) => void;
  onImport: (connectionId: string) => void;
  onListChange: (
    connectionId: string,
    listIds: string[],
    resources: ConnectorResourceOption[],
    projectBindings: Record<string, string>
  ) => void;
}) {
  const canImport = subscribedListCount(connection) > 0;
  return (
    <>
      <AccountPanel provider={provider} connection={connection} />
      <ClickUpTicketSyncPanel />
      <div class="catalog-section-label">
        List → project mapping
        <div class="catalog-section-actions">
          <button
            class="btn"
            type="button"
            data-sync-clickup-lists={connection.id}
            disabled={syncing}
            onClick={() => onSync(connection.id)}
          >
            <SpinningIcon name="refresh" size={14} spinning={syncing} />
            <span>Sync lists</span>
          </button>
          <button
            class="btn btn-primary"
            type="button"
            data-import={connection.id}
            disabled={!canImport}
            onClick={(event) =>
              void withPending(event.currentTarget as HTMLButtonElement, async () => {
                await onImport(connection.id);
              })
            }
          >
            <Icon name="inbox" size={14} />
            <span>Import</span>
          </button>
        </div>
      </div>
      <section class="catalog-panel catalog-panel-fill">
        <ClickUpListControl connection={connection} resources={resources} projects={projects} onChange={onListChange} />
      </section>
    </>
  );
}

export function DetailPanel({
  provider,
  connection,
  resources,
  projects,
  syncing,
  onConnectToken,
  onConnectGh,
  onDisconnect,
  onSync,
  onImport,
  onListChange
}: {
  provider: ConnectorProviderStatus;
  connection?: ConnectorConnection;
  resources: ConnectorResourceOption[];
  projects: ProjectSummary[];
  syncing: boolean;
  onConnectToken: (providerId: string, token: string) => void;
  onConnectGh: () => void;
  onDisconnect: (connectionId: string) => void;
  onSync: (connectionId: string) => void;
  onImport: (connectionId: string) => void;
  onListChange: (
    connectionId: string,
    listIds: string[],
    resources: ConnectorResourceOption[],
    projectBindings: Record<string, string>
  ) => void;
}) {
  const connected = !!connection && connection.status !== "disconnected";
  const headerActions = connected ? (
    <button
      class="btn btn-ghost btn-danger"
      type="button"
      data-disconnect={connection?.id}
      onClick={() => connection && onDisconnect(connection.id)}
    >
      <Icon name="x" size={14} />
      <span>Disconnect</span>
    </button>
  ) : null;

  return (
    <div class="catalog-detail-inner">
      <IdentityHeader provider={provider} {...(connection ? { connection } : {})} actions={headerActions} />
      {connection?.status === "error" && connection.lastError ? (
        <p class="connector-error">{connection.lastError}</p>
      ) : null}
      {connected && connection ? (
        provider.id === "clickup" ? (
          <ClickUpDetail
            provider={provider}
            connection={connection}
            resources={resources}
            projects={projects}
            syncing={syncing}
            onSync={onSync}
            onImport={onImport}
            onListChange={onListChange}
          />
        ) : (
          <GitDetail provider={provider} connection={connection} onImport={onImport} />
        )
      ) : (
        <ConnectPanel provider={provider} onConnectToken={onConnectToken} onConnectGh={onConnectGh} />
      )}
    </div>
  );
}
