import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";
import { relativeTime } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { agentVisual } from "@ui/features/tasks/detail/workflow/panel/step-setting-visual.js";
import { AgentLogo, isKnownAgentLogo } from "@ui/features/tasks/detail/workflow/panel/agent-logo.js";
import type { AgentConfigBundle, AgentToolConfig, ModelPoolConfig } from "../../../../core/agents/config/types.ts";
import type { UsageSnapshot, UsageSnapshots } from "../../../../core/agents/config/usage.ts";

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

/** Live usage text for a pool: provider percent + reset when available, else honest fallback. */
function poolUsageText(pool: ModelPoolConfig, snap?: UsageSnapshot): string {
  if (snap?.error) return `usage error: ${snap.error}`;
  if (snap?.usedPercent !== undefined) {
    const window = snap.windowLabel ? ` ${snap.windowLabel}` : "";
    const reset = resetCountdown(snap.resetsAt);
    return `${Math.round(snap.usedPercent)}% used${window}${reset ? ` · ${reset}` : ""}`;
  }
  if (pool.usageSource === "none" || pool.usage.kind === "unavailable") return "usage unavailable";
  return "no usage yet — refresh";
}

function poolUsageTone(pool: ModelPoolConfig, snap?: UsageSnapshot): "available" | "nearing" | "exhausted" | "unknown" {
  if (snap?.usedPercent === undefined) return "unknown";
  if (snap.usedPercent >= 100) return "exhausted";
  if (snap.usedPercent >= (pool.usage.softThresholdPercent ?? 80)) return "nearing";
  return "available";
}

function poolsForTool(config: AgentConfigBundle, toolId: string): ModelPoolConfig[] {
  return config.pools.filter((pool) => pool.toolId === toolId);
}

function ToolRow({
  tool,
  config,
  snapshots
}: {
  tool: AgentToolConfig;
  config: AgentConfigBundle;
  snapshots: Map<string, UsageSnapshot>;
}) {
  const [busy, setBusy] = useState(false);

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
  const pools = poolsForTool(config, tool.id);

  return (
    <article class="tool-card" data-tool={tool.id}>
      <div class="tool-head">
        <div class="tool-id">
          <span class="tool-swatch" style={knownLogo ? undefined : `color:${visual.color}`}>
            {isKnownAgentLogo(tool.id) ? <AgentLogo id={tool.id} title={tool.displayName} /> : visual.initial}
          </span>
          <div class="tool-id-text">
            <div class="tool-name">{tool.displayName}</div>
            <div class="tool-cmd">
              <code>{tool.command}</code> · adapter {tool.adapter}
            </div>
          </div>
        </div>
        <div class="tool-head-right">
          <label class="settings-switch" title={tool.enabled ? "Enabled" : "Disabled"}>
            <input type="checkbox" checked={tool.enabled} disabled={busy} onChange={() => void toggle()} />
            <span class="settings-switch-track" />
          </label>
          {tool.builtin ? (
            <span class="tool-badge">built-in</span>
          ) : (
            <button class="btn btn-sm btn-danger" type="button" onClick={() => void remove()}>
              Delete
            </button>
          )}
        </div>
      </div>
      <ul class="pool-list">
        {pools.map((pool) => {
          const snap = snapshots.get(snapshotKey(pool.toolId, pool.id));
          const tone = poolUsageTone(pool, snap);
          const pct = snap?.usedPercent !== undefined ? Math.min(100, Math.max(0, Math.round(snap.usedPercent))) : 0;
          return (
            <li key={pool.id} class="pool-row">
              <span class="pool-name">{pool.displayName}</span>
              <span class={`pool-tier${pool.tier === "free" ? " is-free" : ""}`}>{pool.tier}</span>
              <span class="pool-q">q{pool.qualityWeight}</span>
              {pool.capabilities.length ? (
                <span class="pool-caps">[{pool.capabilities.join(", ")}]</span>
              ) : null}
              <span class="pool-usage">
                <span class="usage-bar">
                  <span class={`usage-fill is-${tone}`} style={`width:${pct}%`} />
                </span>
                <span class="usage-text">{poolUsageText(pool, snap)}</span>
              </span>
            </li>
          );
        })}
        {pools.length === 0 ? <li class="pool-empty muted">No model pools.</li> : null}
      </ul>
    </article>
  );
}

export function AgentConfigSection() {
  const config = ui.data?.agentConfig;
  const usage = ui.data?.agentUsageSnapshots as UsageSnapshots | undefined;
  const [refreshing, setRefreshing] = useState(false);

  if (!config) return null;

  async function refreshUsage(): Promise<void> {
    setRefreshing(true);
    try {
      await api("/api/agent-config/usage/refresh", { method: "POST" });
      toast("Usage refreshed for provider-backed pools.", { tone: "success" });
      refresh();
    } catch {
      toast("Failed to refresh usage.", { tone: "error" });
    } finally {
      setRefreshing(false);
    }
  }

  const snapshots = indexSnapshots(usage);
  const usageMeta = usage?.snapshots.length
    ? `Usage updated ${relativeTime(usage.refreshedAt)}`
    : "No usage recorded yet";

  return (
    <section class="settings-section" data-settings-panel="agent-config">
      <div class="catalog-section-label">
        Tools &amp; model pools
        <div class="catalog-section-actions">
          <span class="settings-usage-meta">{usageMeta}</span>
          <button class="btn btn-sm" type="button" disabled={refreshing} onClick={() => void refreshUsage()}>
            {refreshing ? "Refreshing…" : "Refresh usage"}
          </button>
        </div>
      </div>

      <div class="agent-policy-grid">
        {config.tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} config={config} snapshots={snapshots} />
        ))}
      </div>

      <p class="agent-config-foot muted">
        Configured in <code>data/state/agent-config.json</code> — add new CLIs with the{" "}
        <strong>add-agent-cli</strong> skill.
      </p>
    </section>
  );
}
