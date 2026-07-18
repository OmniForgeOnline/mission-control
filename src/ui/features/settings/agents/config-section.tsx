import { useEffect, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { agentVisual } from "@ui/features/tasks/detail/workflow/panel/step-setting-visual.js";
import { AgentLogo, isKnownAgentLogo } from "@ui/features/tasks/detail/workflow/panel/agent-logo.js";
import type { AgentConfigBundle, AgentToolConfig, ModelPoolConfig } from "../../../../core/agents/config/types.ts";
import type { ToolExtension } from "../../../../core/agents/extensions/types.ts";
import type { UsageSnapshot, UsageSnapshots } from "../../../../core/agents/config/usage.ts";
import { AgentCliSetupModal } from "./cli-setup-modal.js";
import { ExtensionsModal } from "./extensions-modal.js";
import { INLINE_MODEL_PREVIEW, sortPoolsForDisplay } from "./model-list.js";
import { PoolRow } from "./model-pools.js";
import { ModelsModal } from "./models-modal.js";
import { toolSetupActions, type ToolRuntimePresence, type ToolSetupMode } from "./tool-setup.js";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

function snapshotKey(toolId: string, modelPoolId?: string): string {
  return modelPoolId ? `${toolId}::${modelPoolId}` : toolId;
}

function indexSnapshots(usage: UsageSnapshots | undefined): Map<string, UsageSnapshot> {
  const index = new Map<string, UsageSnapshot>();
  for (const snap of usage?.snapshots ?? []) {
    index.set(snapshotKey(snap.toolId, snap.modelPoolId), snap);
  }
  return index;
}

function resetCountdown(resetsAt?: number): string {
  if (!resetsAt) return "";
  const seconds = resetsAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "resetting";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

/**
 * Resolve the account-level usage snapshot for a tool.
 * Prefer a tool-scoped snap; fall back to any pool-scoped snap (legacy / runtime).
 */
function toolUsageSnapshot(
  toolId: string,
  pools: ModelPoolConfig[],
  snapshots: Map<string, UsageSnapshot>
): UsageSnapshot | undefined {
  const toolSnap = snapshots.get(snapshotKey(toolId));
  if (toolSnap) return toolSnap;
  for (const pool of pools) {
    const poolSnap = snapshots.get(snapshotKey(toolId, pool.id));
    if (poolSnap) return poolSnap;
  }
  return undefined;
}

/** Whether this tool has any live usage source (account quota can be shown). */
function toolHasLiveUsage(tool: AgentToolConfig, pools: ModelPoolConfig[]): boolean {
  if (tool.usage.kind === "unavailable") return false;
  return pools.some((pool) => pool.usageSource !== "none");
}

/** Live usage text for a tool account: provider percent + reset when available. */
function toolUsageText(tool: AgentToolConfig, snap?: UsageSnapshot): string {
  if (snap?.error) return `usage error: ${snap.error}`;
  if (snap?.usedPercent !== undefined) {
    const window = snap.windowLabel ? ` ${snap.windowLabel}` : "";
    const reset = resetCountdown(snap.resetsAt);
    return `${Math.round(snap.usedPercent)}% used${window}${reset ? ` · ${reset}` : ""}`;
  }
  if (tool.usage.kind === "unavailable") return "usage unavailable";
  return "no usage yet — refresh";
}

function toolUsageTone(tool: AgentToolConfig, snap?: UsageSnapshot): "available" | "nearing" | "exhausted" | "unknown" {
  if (snap?.usedPercent === undefined) return "unknown";
  if (snap.usedPercent >= 100) return "exhausted";
  if (snap.usedPercent >= (tool.usage.softThresholdPercent ?? 80)) return "nearing";
  return "available";
}

function poolsForTool(config: AgentConfigBundle, toolId: string): ModelPoolConfig[] {
  return config.pools.filter((pool) => pool.toolId === toolId);
}

function extensionsForTool(extensions: ToolExtension[] | undefined, toolId: string): ToolExtension[] {
  return (extensions ?? []).filter((entry) => entry.toolId === toolId);
}

function ToolRow({
  tool,
  config,
  snapshots,
  extensions,
  presence,
  onRescan,
  rescanning
}: {
  tool: AgentToolConfig;
  config: AgentConfigBundle;
  snapshots: Map<string, UsageSnapshot>;
  extensions: ToolExtension[];
  presence: ToolRuntimePresence | undefined;
  onRescan: (toolId: string, opts?: { silent?: boolean }) => Promise<void>;
  rescanning: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<ToolSetupMode | null>(null);
  const toolExtensions = extensionsForTool(extensions, tool.id);
  const supportsExtensions = tool.adapter === "claude" || tool.adapter === "codex" || tool.id === "kiro" || tool.id === "cursor";
  const setup = toolSetupActions(tool, presence);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await api("/api/agent-config/tools", {
        method: "PUT",
        body: JSON.stringify({ ...tool, enabled: !tool.enabled })
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update tool.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    const ok = await confirm({
      title: `Delete ${tool.displayName}?`,
      message: `Remove tool "${tool.id}" and its model pools.`,
      confirmLabel: "Delete",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/agent-config/tools/${tool.id}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete tool.", { tone: "error" });
    }
  }

  const knownLogo = isKnownAgentLogo(tool.id);
  const visual = agentVisual(tool.id, tool.displayName);
  const pools = sortPoolsForDisplay(poolsForTool(config, tool.id));
  const previewPools = pools.slice(0, INLINE_MODEL_PREVIEW);
  const hiddenPoolCount = Math.max(0, pools.length - previewPools.length);
  const showUsage = toolHasLiveUsage(tool, pools);
  const snap = showUsage ? toolUsageSnapshot(tool.id, pools, snapshots) : undefined;
  const tone = showUsage ? toolUsageTone(tool, snap) : "unknown";
  const pct = snap?.usedPercent !== undefined ? Math.min(100, Math.max(0, Math.round(snap.usedPercent))) : 0;

  return (
    <article class={`tool-card${tool.enabled ? "" : " is-disabled"}`} data-tool={tool.id}>
      <div class="tool-head">
        <div class="tool-id">
          <span class="tool-swatch" style={knownLogo ? undefined : `color:${visual.color}`}>
            {isKnownAgentLogo(tool.id) ? <AgentLogo id={tool.id} title={tool.displayName} /> : visual.initial}
          </span>
          <div class="tool-id-text">
            <div class="tool-name-row">
              <div class="tool-name">{tool.displayName}</div>
              {setup.available === true ? (
                <span class="tool-presence is-ready">Ready</span>
              ) : setup.available === false ? (
                <span class="tool-presence is-missing">Not installed</span>
              ) : (
                <span class="tool-presence is-unknown">Checking…</span>
              )}
            </div>
            <div class="tool-cmd">
              <code>{tool.command}</code>
              {presence?.command && presence.command !== tool.command ? (
                <span class="tool-resolved muted" title={presence.command}>
                  → {presence.command}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div class="tool-head-right">
          {!tool.builtin ? (
            <button class="btn btn-sm btn-danger" type="button" onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
          <label class="settings-switch" title={tool.enabled ? "Enabled" : "Disabled"}>
            <input type="checkbox" checked={tool.enabled} disabled={busy} onChange={() => void toggle()} />
            <span class="settings-switch-track" />
          </label>
        </div>
      </div>
      <div class="tool-setup-actions">
        {setup.showInstall ? (
          <button class="btn btn-sm btn-primary" type="button" onClick={() => setSetupMode("install")}>
            Install
          </button>
        ) : null}
        {setup.showLogin ? (
          <button class="btn btn-sm" type="button" onClick={() => setSetupMode("login")}>
            Login
          </button>
        ) : null}
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          disabled={rescanning}
          onClick={() => void onRescan(tool.id)}
        >
          {rescanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {showUsage ? (
        <div class="tool-usage" title="Account quota for this tool (shared across models)">
          <span class="usage-bar">
            <span class={`usage-fill is-${tone}`} style={`width:${pct}%`} />
          </span>
          <span class="usage-text">{toolUsageText(tool, snap)}</span>
        </div>
      ) : null}
      <ul class="pool-list">
        {previewPools.map((pool) => (
          <PoolRow key={pool.id} pool={pool} />
        ))}
        {pools.length === 0 ? <li class="pool-empty muted">No models yet.</li> : null}
      </ul>
      {hiddenPoolCount > 0 ? (
        <button class="btn btn-sm btn-ghost pool-more" type="button" onClick={() => setModelsOpen(true)}>
          +{hiddenPoolCount} more — view all {pools.length} models
        </button>
      ) : null}
      <div class="model-actions">
        <button class="btn btn-sm btn-ghost" type="button" onClick={() => setModelsOpen(true)}>
          Models ({pools.length})
        </button>
        {supportsExtensions ? (
          <button
            class="btn btn-sm btn-ghost"
            type="button"
            onClick={() => setExtensionsOpen(true)}
          >
            Extensions ({toolExtensions.length})
          </button>
        ) : null}
      </div>
      <ModelsModal tool={tool} pools={pools} open={modelsOpen} onClose={() => setModelsOpen(false)} />
      {supportsExtensions ? (
        <ExtensionsModal
          tool={tool}
          extensions={toolExtensions}
          open={extensionsOpen}
          onClose={() => setExtensionsOpen(false)}
        />
      ) : null}
      {setupMode ? (
        <AgentCliSetupModal
          tool={tool}
          mode={setupMode}
          open
          onClose={() => setSetupMode(null)}
          onProbed={(id) => void onRescan(id, { silent: true })}
        />
      ) : null}
    </article>
  );
}

type RuntimeDiagnosticsMap = Record<string, ToolRuntimePresence>;

export function AgentConfigSection() {
  const config = ui.data?.agentConfig;
  const usage = ui.data?.agentUsageSnapshots as UsageSnapshots | undefined;
  const registry = ui.data?.agentExtensions;
  const [refreshing, setRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnosticsMap>({});
  const [rescanningId, setRescanningId] = useState<string | "all" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api<{ runtimeDiagnostics?: RuntimeDiagnosticsMap }>("/api/agent-config/probe", {
          method: "POST",
          body: JSON.stringify({})
        });
        if (!cancelled && result?.runtimeDiagnostics) {
          setDiagnostics(result.runtimeDiagnostics);
        }
      } catch {
        /* presence is best-effort on first paint */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config?.tools.map((tool) => tool.id).join(",")]);

  if (!config) return null;

  async function refreshUsage(): Promise<void> {
    setRefreshing(true);
    try {
      await api("/api/agent-config/usage/refresh", { method: "POST" });
      toast("Usage refreshed for provider-backed tools.", { tone: "success" });
      refresh();
    } catch {
      toast("Failed to refresh usage.", { tone: "error" });
    } finally {
      setRefreshing(false);
    }
  }

  async function discoverExtensions(): Promise<void> {
    setDiscovering(true);
    try {
      await api("/api/agent-config/extensions/discover", { method: "POST" });
      toast("Extensions refreshed from tool configs on disk.", { tone: "success" });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to discover extensions.", { tone: "error" });
    } finally {
      setDiscovering(false);
    }
  }

  async function rescan(toolId?: string, opts?: { silent?: boolean }): Promise<void> {
    setRescanningId(toolId ?? "all");
    try {
      const result = await api<{ runtimeDiagnostics?: RuntimeDiagnosticsMap }>("/api/agent-config/probe", {
        method: "POST",
        body: JSON.stringify(toolId ? { toolId } : {})
      });
      if (result?.runtimeDiagnostics) {
        setDiagnostics((prev) =>
          toolId ? { ...prev, ...result.runtimeDiagnostics } : { ...result.runtimeDiagnostics }
        );
      }
      if (!opts?.silent) {
        toast(toolId ? `Rescanned ${toolId}.` : "Rescanned all agent CLIs.", { tone: "success" });
      }
    } catch (err) {
      if (!opts?.silent) {
        toast(err instanceof Error ? err.message : "Rescan failed.", { tone: "error" });
      }
    } finally {
      setRescanningId(null);
    }
  }

  const snapshots = indexSnapshots(usage);

  return (
    <section class="settings-section" data-settings-panel="agent-config">
      <div class="catalog-section-label">
        Tools &amp; models
        <div class="catalog-section-actions">
          <button
            class="btn btn-sm"
            type="button"
            disabled={rescanningId !== null}
            onClick={() => void rescan()}
          >
            {rescanningId === "all" ? "Scanning…" : "Rescan CLIs"}
          </button>
          <button class="btn btn-sm" type="button" disabled={refreshing} onClick={() => void refreshUsage()}>
            {refreshing ? "Refreshing…" : "Refresh usage"}
          </button>
          <button class="btn btn-sm" type="button" disabled={discovering} onClick={() => void discoverExtensions()}>
            {discovering ? "Discovering…" : "Refresh extensions"}
          </button>
        </div>
      </div>

      <div class="agent-policy-grid">
        {config.tools.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            config={config}
            snapshots={snapshots}
            extensions={registry?.extensions ?? []}
            presence={diagnostics[tool.id]}
            onRescan={rescan}
            rescanning={rescanningId === tool.id || rescanningId === "all"}
          />
        ))}
      </div>
    </section>
  );
}
