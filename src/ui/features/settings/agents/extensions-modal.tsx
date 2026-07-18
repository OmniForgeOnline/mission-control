import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { bindDialogDismiss } from "@ui/overlays/dialog.js";
import type { AgentToolConfig } from "../../../../core/agents/config/types.ts";
import type { ToolExtension } from "../../../../core/agents/extensions/types.ts";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

function InstallMarketplaceForm({ toolId, adapter }: { toolId: string; adapter: string }) {
  const [source, setSource] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [busy, setBusy] = useState(false);

  if (adapter !== "claude" && adapter !== "codex") return null;

  async function install(): Promise<void> {
    const trimmed = source.trim();
    if (!trimmed) {
      toast("Enter plugin@marketplace to install.", { tone: "error" });
      return;
    }
    const ok = await confirm({
      title: "Install marketplace plugin?",
      message: `Install "${trimmed}" into your global ${toolId} user config? Mission Control still scopes enablement per launch/workflow step.`,
      confirmLabel: "Install",
      tone: "danger"
    });
    if (!ok) return;

    setBusy(true);
    try {
      await api("/api/agent-config/extensions/install", {
        method: "POST",
        body: JSON.stringify({
          toolId,
          source: trimmed,
          ...(marketplaceSource.trim() ? { marketplaceSource: marketplaceSource.trim() } : {}),
          confirmed: true
        })
      });
      toast("Plugin installed and registry updated.", { tone: "success" });
      setSource("");
      setMarketplaceSource("");
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Install failed.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="extension-install-form">
      <div class="extension-install-label">Install from marketplace</div>
      <div class="extension-install-row">
        <input
          class="input"
          type="text"
          placeholder="plugin@marketplace"
          value={source}
          disabled={busy}
          onInput={(e) => setSource((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="btn btn-sm" type="button" disabled={busy} onClick={() => void install()}>
          {busy ? "Installing…" : "Install"}
        </button>
      </div>
      <input
        class="input extension-install-marketplace"
        type="text"
        placeholder="Optional marketplace source (owner/repo) if not registered yet"
        value={marketplaceSource}
        disabled={busy}
        onInput={(e) => setMarketplaceSource((e.currentTarget as HTMLInputElement).value)}
      />
    </div>
  );
}

function ExtensionRow({ extension }: { extension: ToolExtension }) {
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await api("/api/agent-config/extensions", {
        method: "PUT",
        body: JSON.stringify({ ...extension, defaultEnabled: !extension.defaultEnabled })
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update extension.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class="extension-row">
      <span class={`extension-kind is-${extension.kind}`}>{extension.kind}</span>
      <span class="extension-name" title={extension.displayName}>
        {extension.displayName}
      </span>
      <code class="extension-source" title={extension.source}>
        {extension.source}
      </code>
      <label class="settings-switch" title={extension.defaultEnabled ? "Enabled by default" : "Opt-in per step"}>
        <input type="checkbox" checked={extension.defaultEnabled} disabled={busy} onChange={() => void toggle()} />
        <span class="settings-switch-track" />
      </label>
    </li>
  );
}

/** Modal host for a tool's extensions — wider than the card so rows stay single-line. */
export function ExtensionsModal({
  tool,
  extensions,
  open,
  onClose
}: {
  tool: AgentToolConfig;
  extensions: ToolExtension[];
  open: boolean;
  onClose: () => void;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);

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

  return (
    <dialog ref={dlgRef} class="extensions-dialog" aria-labelledby={`ext-title-${tool.id}`}>
      <div class="extensions-panel">
        <div class="extensions-panel-head">
          <div class="extensions-panel-titles">
            <h2 id={`ext-title-${tool.id}`} class="extensions-panel-title">
              {tool.displayName} extensions
            </h2>
            <p class="extensions-panel-sub muted">
              Defaults apply to MC-managed launches. Toggle off to require opt-in per step.
            </p>
          </div>
          <button class="btn btn-sm btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div class="extensions-panel-body">
          <InstallMarketplaceForm toolId={tool.id} adapter={tool.adapter} />
          {extensions.length ? (
            <ul class="extension-list">
              {extensions.map((extension) => (
                <ExtensionRow key={extension.id} extension={extension} />
              ))}
            </ul>
          ) : (
            <p class="extension-empty muted">
              No extensions discovered yet — install above or use Refresh extensions.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
