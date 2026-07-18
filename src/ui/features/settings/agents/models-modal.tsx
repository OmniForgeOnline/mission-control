import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import { bindDialogDismiss } from "@ui/overlays/dialog.js";
import type { AgentToolConfig, ModelPoolConfig } from "../../../../core/agents/config/types.ts";
import { AddModelForm, PoolRow } from "./model-pools.js";
import { sortPoolsForDisplay } from "./model-list.js";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

export function ModelsModal({
  tool,
  pools,
  open,
  onClose
}: {
  tool: AgentToolConfig;
  pools: ModelPoolConfig[];
  open: boolean;
  onClose: () => void;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [discovering, setDiscovering] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const supportsDiscover = tool.id === "codex" || tool.id === "cursor";
  const sorted = sortPoolsForDisplay(pools);
  const enabledCount = pools.filter((pool) => pool.enabled).length;

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      bindDialogDismiss(dlg);
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    const handleClose = (): void => onClose();
    dlg.addEventListener("close", handleClose);
    return () => dlg.removeEventListener("close", handleClose);
  }, [onClose]);

  async function discoverModels(): Promise<void> {
    setDiscovering(true);
    try {
      const result = await api<{ discovered?: number }>("/api/agent-config/models/discover", {
        method: "POST",
        body: JSON.stringify({ toolId: tool.id })
      });
      const count = result?.discovered ?? 0;
      toast(
        count > 0
          ? `Discovered ${count} models for ${tool.displayName}${
              tool.id === "cursor" ? " (new ones left disabled)" : ""
            }.`
          : "No models discovered. Is the tool installed and logged in?",
        { tone: count > 0 ? "success" : "error" }
      );
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Model discovery failed.", { tone: "error" });
    } finally {
      setDiscovering(false);
    }
  }

  async function setAllEnabled(enabled: boolean): Promise<void> {
    if (pools.length === 0) return;
    setBulkBusy(true);
    try {
      await api("/api/agent-config/pools/bulk-enabled", {
        method: "POST",
        body: JSON.stringify({ toolId: tool.id, enabled })
      });
      toast(enabled ? `Enabled all ${pools.length} models.` : `Disabled all ${pools.length} models.`, {
        tone: "success"
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update models.", { tone: "error" });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <dialog ref={dlgRef} class="models-dialog" aria-labelledby={`models-title-${tool.id}`}>
      <div class="models-panel">
        <div class="models-panel-head">
          <div class="models-panel-titles">
            <h2 id={`models-title-${tool.id}`} class="models-panel-title">
              {tool.displayName} models
            </h2>
            <p class="models-panel-sub muted">
              Enabled models appear in step dropdowns ({enabledCount} of {pools.length} on). Use
              Disable all when a discover pass adds more than you need.
            </p>
          </div>
          <button class="btn btn-sm btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div class="models-panel-body">
          <div class="models-panel-actions">
            <AddModelForm toolId={tool.id} />
            {supportsDiscover ? (
              <button
                class="btn btn-sm"
                type="button"
                disabled={discovering || bulkBusy}
                onClick={() => void discoverModels()}
              >
                {discovering ? "Discovering…" : "Discover models"}
              </button>
            ) : null}
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              disabled={bulkBusy || pools.length === 0 || enabledCount === 0}
              onClick={() => void setAllEnabled(false)}
            >
              Disable all
            </button>
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              disabled={bulkBusy || pools.length === 0 || enabledCount === pools.length}
              onClick={() => void setAllEnabled(true)}
            >
              Enable all
            </button>
          </div>
          {sorted.length ? (
            <ul class="pool-list models-modal-list">
              {sorted.map((pool) => (
                <PoolRow key={pool.id} pool={pool} />
              ))}
            </ul>
          ) : (
            <p class="models-empty muted">No models yet — add one or discover from the CLI.</p>
          )}
        </div>
      </div>
    </dialog>
  );
}
