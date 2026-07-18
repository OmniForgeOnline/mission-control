import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import { bindDialogDismiss } from "@ui/overlays/dialog.js";
import { agentVisual } from "@ui/features/tasks/detail/workflow/panel/step-setting-visual.js";
import { AgentLogo, isKnownAgentLogo } from "@ui/features/tasks/detail/workflow/panel/agent-logo.js";
import type { AgentToolConfig } from "@harness/core/agents/config/types.ts";
import { AgentCliSetupModal } from "../settings/agents/cli-setup-modal.js";
import {
  toolSetupActions,
  type ToolPresenceMap,
  type ToolRuntimePresence
} from "../settings/agents/tool-setup.js";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

function CliOnboardingRow({
  tool,
  presence,
  busyId,
  onEnable,
  onInstall
}: {
  tool: AgentToolConfig;
  presence: ToolRuntimePresence | undefined;
  busyId: string | null;
  onEnable: (tool: AgentToolConfig) => void;
  onInstall: (tool: AgentToolConfig) => void;
}) {
  const setup = toolSetupActions(tool, presence);
  const visual = agentVisual(tool.id, tool.displayName);
  const busy = busyId === tool.id;

  return (
    <li class={`cli-onboard-row${tool.enabled ? "" : " is-disabled"}`} data-tool={tool.id}>
      <div class="cli-onboard-id">
        <span class="tool-swatch" style={isKnownAgentLogo(tool.id) ? undefined : `color:${visual.color}`}>
          {isKnownAgentLogo(tool.id) ? <AgentLogo id={tool.id} title={tool.displayName} /> : visual.initial}
        </span>
        <div class="cli-onboard-id-text">
          <div class="cli-onboard-name-row">
            <strong>{tool.displayName}</strong>
            {setup.available === true ? (
              <span class="tool-presence is-ready">Ready</span>
            ) : setup.available === false ? (
              <span class="tool-presence is-missing">Not installed</span>
            ) : (
              <span class="tool-presence is-unknown">Checking…</span>
            )}
          </div>
          <div class="cli-onboard-cmd">
            <code>{tool.command}</code>
            {presence?.command && presence.command !== tool.command ? (
              <span class="muted" title={presence.command}>
                → {presence.command}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div class="cli-onboard-actions">
        {setup.showEnable ? (
          <button class="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => onEnable(tool)}>
            {busy ? "Enabling…" : "Enable"}
          </button>
        ) : null}
        {setup.showInstall ? (
          <button class="btn btn-sm btn-primary" type="button" onClick={() => onInstall(tool)}>
            Install
          </button>
        ) : null}
        {setup.available === false && !setup.showInstall && tool.setup?.docsUrl ? (
          <a class="btn btn-sm btn-ghost" href={tool.setup.docsUrl} target="_blank" rel="noreferrer">
            Docs
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function CliOnboardingModal({
  open,
  tools,
  presence,
  probing,
  onClose,
  onRescan
}: {
  open: boolean;
  tools: readonly AgentToolConfig[];
  presence: ToolPresenceMap;
  probing: boolean;
  onClose: () => void;
  onRescan: (toolId?: string) => Promise<void>;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installTool, setInstallTool] = useState<AgentToolConfig | null>(null);

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
    const handleClose = (): void => {
      onClose();
    };
    dlg.addEventListener("close", handleClose);
    return () => dlg.removeEventListener("close", handleClose);
  });

  async function enable(tool: AgentToolConfig): Promise<void> {
    setBusyId(tool.id);
    try {
      await api("/api/agent-config/tools", {
        method: "PUT",
        body: JSON.stringify({ ...tool, enabled: true })
      });
      toast(`Enabled ${tool.displayName}.`, { tone: "success" });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to enable tool.", { tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <dialog ref={dlgRef} class="cli-onboard-dialog" aria-labelledby="cliOnboardTitle">
        <div class="cli-onboard-panel">
          <div class="cli-onboard-head">
            <div>
              <h2 id="cliOnboardTitle" class="cli-onboard-title">
                Agent CLIs
              </h2>
              <p class="cli-onboard-sub muted">
                Enable CLIs already on your PATH, or install missing ones. At least one ready agent is
                enough to continue.
              </p>
            </div>
            <div class="cli-onboard-head-actions">
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                disabled={probing}
                onClick={() => void onRescan()}
              >
                {probing ? "Scanning…" : "Rescan"}
              </button>
              <button class="btn btn-sm" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
          <ul class="cli-onboard-list">
            {tools.map((tool) => (
              <CliOnboardingRow
                key={tool.id}
                tool={tool}
                presence={presence[tool.id]}
                busyId={busyId}
                onEnable={(entry) => void enable(entry)}
                onInstall={setInstallTool}
              />
            ))}
          </ul>
        </div>
      </dialog>
      {installTool ? (
        <AgentCliSetupModal
          tool={installTool}
          mode="install"
          open
          onClose={() => setInstallTool(null)}
          onProbed={(id) => void onRescan(id)}
        />
      ) : null}
    </>
  );
}
