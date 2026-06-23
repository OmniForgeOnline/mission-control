import type {
  ConnectorResourceOption,
  ConnectorsState
} from "../../../core/types.ts";
import { useEffect, useMemo, useState } from "preact/hooks";
import { render } from "preact";
import { api } from "@ui/data/api.js";
import { $ } from "@ui/shell/dom.js";
import { parseHash } from "@ui/app/router.js";
import { ui } from "@ui/app/state.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import {
  Catalog,
  DetailPanel,
  connectionForProvider,
  subscribedListCount
} from "./connector-view-components.js";

function connectorsState(): ConnectorsState {
  const raw = ui.data?.connectors;
  if (!raw || typeof raw !== "object") {
    return { providers: [], connections: [] };
  }
  return raw as ConnectorsState;
}

function ConnectorsView({ state }: { state: ConnectorsState }) {
  const [clickUpResources, setClickUpResources] = useState<ConnectorResourceOption[]>([]);
  const [syncingClickUpConnectionId, setSyncingClickUpConnectionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");

  const providers = state.providers;

  // Default selection: first connected provider, else first provider.
  useEffect(() => {
    if (selectedId && providers.some((p) => p.id === selectedId)) return;
    const firstConnected = providers.find((p) => connectionForProvider(state.connections, p.id));
    setSelectedId(firstConnected?.id ?? providers[0]?.id ?? "");
  }, [providers, state.connections, selectedId]);

  useEffect(() => {
    const { query: hashQuery } = parseHash();
    const connected = hashQuery.get("connected");
    if (connected) {
      toast(`${connected} connected.`, { tone: "success" });
      window.location.hash = "#/connectors";
    }
  }, []);

  useEffect(() => {
    const clickUpConnection = connectionForProvider(state.connections, "clickup");
    setClickUpResources(clickUpConnection?.config.clickup?.cachedResources ?? []);
  }, [state.connections]);

  async function handleConnectToken(providerId: string, token: string): Promise<void> {
    await api(`/api/connectors/${providerId}/connect`, {
      method: "POST",
      body: JSON.stringify({ method: "token", token })
    });
    toast(`${providerId} connected.`, { tone: "success" });
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  }

  async function handleConnectGh(): Promise<void> {
    await api("/api/connectors/github/connect", {
      method: "POST",
      body: JSON.stringify({ method: "gh" })
    });
    toast("GitHub connected via CLI.", { tone: "success" });
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  }

  async function handleDisconnect(connectionId: string): Promise<void> {
    const ok = await confirm({
      title: "Disconnect connector?",
      message: "Imported bindings stay, but live sync stops until you reconnect.",
      confirmLabel: "Disconnect",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/connectors/${connectionId}`, { method: "DELETE" });
      toast("Connector disconnected.");
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  async function handleImport(connectionId: string): Promise<void> {
    const ok = await confirm({
      title: "Import connector tasks?",
      message: "This scans accessible repos or lists and may create many new tasks.",
      confirmLabel: "Import",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/connectors/${connectionId}/import`, { method: "POST" });
      toast("Imported connector tasks.");
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  async function handleClickUpListChange(
    connectionId: string,
    listIds: string[],
    resources: ConnectorResourceOption[],
    projectBindings: Record<string, string>
  ): Promise<void> {
    const first = resources[0];
    const clickUpConnection = connectionForProvider(state.connections, "clickup");
    const currentClickUp = clickUpConnection?.config.clickup ?? {};
    await api(`/api/connectors/${connectionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          clickup: {
            ...currentClickUp,
            teamId: first?.meta?.["teamId"] ?? currentClickUp.teamId ?? "",
            listId: listIds[0] ?? "",
            subscribedListIds: listIds,
            listProjectBindings: projectBindings
          }
        }
      })
    });
    toast(listIds.length === 1 ? "ClickUp list saved." : "ClickUp lists saved.");
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  }

  async function handleSyncClickUpLists(connectionId: string): Promise<void> {
    if (syncingClickUpConnectionId) return;
    setSyncingClickUpConnectionId(connectionId);
    try {
      const resources = await api<ConnectorResourceOption[]>(`/api/connectors/${connectionId}/resources?refresh=1`);
      setClickUpResources(resources ?? []);
      toast("ClickUp lists synced.", { tone: "success" });
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setSyncingClickUpConnectionId(null);
    }
  }

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? providers[0],
    [providers, selectedId]
  );
  const selectedConnection = selectedProvider
    ? connectionForProvider(state.connections, selectedProvider.id)
    : undefined;

  const connectedCount = providers.filter((p) => connectionForProvider(state.connections, p.id)).length;
  const polledLists = subscribedListCount(connectionForProvider(state.connections, "clickup"));

  return (
    <div class="view catalog-view">
      <div class="view-header catalog-view-header">
        <div>
          <h1 class="view-title">Connectors</h1>
          <p class="view-subtitle">
            Connect trackers, import open work, and auto-bind GitHub/GitLab issues to local repos.
          </p>
        </div>
        <div class="catalog-health">
          <span class="catalog-health-dot" />
          {connectedCount} connected{polledLists ? ` · polling ${polledLists} ${polledLists === 1 ? "list" : "lists"}` : ""}
        </div>
      </div>

      <div class="catalog-shell">
        <Catalog
          providers={providers}
          connections={state.connections}
          selectedId={selectedProvider?.id ?? ""}
          query={query}
          onQuery={setQuery}
          onSelect={setSelectedId}
        />
        <main class="catalog-detail">
          {selectedProvider ? (
            <DetailPanel
              provider={selectedProvider}
              {...(selectedConnection ? { connection: selectedConnection } : {})}
              resources={clickUpResources}
              projects={ui.data?.projects ?? []}
              syncing={selectedConnection?.id === syncingClickUpConnectionId}
              onConnectToken={(providerId, token) => void handleConnectToken(providerId, token)}
              onConnectGh={() => void handleConnectGh()}
              onDisconnect={(connectionId) => void handleDisconnect(connectionId)}
              onSync={(connectionId) => void handleSyncClickUpLists(connectionId)}
              onImport={(connectionId) => void handleImport(connectionId)}
              onListChange={(connectionId, listIds, resources, projectBindings) =>
                void handleClickUpListChange(connectionId, listIds, resources, projectBindings)
              }
            />
          ) : (
            <p class="catalog-empty">No connectors available.</p>
          )}
        </main>
      </div>
    </div>
  );
}

export function renderConnectorsView(): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<ConnectorsView state={connectorsState()} />, root);
}
