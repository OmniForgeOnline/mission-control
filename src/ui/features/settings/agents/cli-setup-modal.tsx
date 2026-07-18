import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import { bindDialogDismiss } from "@ui/overlays/dialog.js";
import { TerminalPane, type TerminalSessionInfo } from "@ui/shared/components/terminal-pane.js";
import type { AgentToolConfig } from "../../../../core/agents/config/types.ts";
import { setupShellCommand, type ToolSetupMode } from "./tool-setup.js";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

export function AgentCliSetupModal({
  tool,
  mode,
  open,
  onClose,
  onProbed
}: {
  tool: AgentToolConfig;
  mode: ToolSetupMode;
  open: boolean;
  onClose: () => void;
  onProbed?: (toolId: string) => void;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const sessionIdRef = useRef<string | undefined>();
  const finishingRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const command = setupShellCommand(tool, mode);

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
    if (!open) {
      setSessionId(undefined);
      setError(null);
      finishingRef.current = false;
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const session = await api<TerminalSessionInfo>("/api/terminal/sessions", {
          method: "POST",
          body: JSON.stringify({
            kind: "shell",
            label: `${mode}:${tool.id}`,
            cols: 100,
            rows: 28
          })
        });
        if (cancelled) {
          if (session?.id) {
            void api(`/api/terminal/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
          }
          return;
        }
        if (!session?.id) {
          throw new Error("Terminal session was not created.");
        }
        sessionIdRef.current = session.id;
        setSessionId(session.id);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to open terminal.";
          setError(message);
          toast(message, { tone: "error" });
        }
      }
    })();

    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      sessionIdRef.current = undefined;
      if (id) {
        void api(`/api/terminal/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
      }
    };
  }, [open, tool.id, mode]);

  async function finish(): Promise<void> {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const id = sessionIdRef.current;
    sessionIdRef.current = undefined;
    setSessionId(undefined);
    if (id) {
      try {
        await api(`/api/terminal/sessions/${id}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }
    onProbed?.(tool.id);
    refresh();
    onClose();
  }

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    const handleClose = (): void => {
      void finish();
    };
    dlg.addEventListener("close", handleClose);
    return () => dlg.removeEventListener("close", handleClose);
  });

  const title = mode === "install" ? `Install ${tool.displayName}` : `Log in to ${tool.displayName}`;
  const copy =
    mode === "install"
      ? `Run the install command in the terminal below, then close when finished. Rescan will check that \`${tool.command}\` is on PATH.`
      : `Complete vendor login in the terminal below. Credentials stay in the CLI — Mission Control does not store API keys.`;

  return (
    <dialog ref={dlgRef} class="cli-setup-dialog" aria-labelledby={`cli-setup-title-${tool.id}`}>
      <div class="cli-setup-panel">
        <div class="cli-setup-head">
          <div class="cli-setup-titles">
            <h2 id={`cli-setup-title-${tool.id}`} class="cli-setup-title">
              {title}
            </h2>
            <p class="cli-setup-sub muted">{copy}</p>
            {tool.setup?.docsUrl ? (
              <p class="cli-setup-docs">
                <a href={tool.setup.docsUrl} target="_blank" rel="noreferrer">
                  Installation docs
                </a>
              </p>
            ) : null}
          </div>
          <button class="btn btn-sm btn-ghost" type="button" onClick={() => void finish()}>
            Done
          </button>
        </div>
        <div class="cli-setup-body">
          {error ? <p class="cli-setup-error">{error}</p> : null}
          <div class="cli-setup-term">
            <TerminalPane sessionId={sessionId} active={open} bootstrapCommand={command} />
          </div>
        </div>
      </div>
    </dialog>
  );
}
