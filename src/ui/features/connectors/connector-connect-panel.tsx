import type { ConnectorProviderStatus } from "../../../core/types.ts";
import { useState } from "preact/hooks";
import { icon } from "@ui/shell/icons.js";
import { toast } from "@ui/overlays/toast.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function ConnectPanel({
  provider,
  onConnectToken,
  onConnectGh
}: {
  provider: ConnectorProviderStatus;
  onConnectToken: (providerId: string, token: string) => void;
  onConnectGh: () => void;
}) {
  const [token, setToken] = useState("");
  const showGhCli = provider.id === "github" && provider.ghCliAvailable;

  return (
    <>
      <div class="catalog-section-label">Connect</div>
      <section class="catalog-panel">
        <div class="catalog-panel-body">
          <div class="connector-connect">
            {showGhCli ? (
              <>
                <button class="btn" type="button" data-provider={provider.id} onClick={onConnectGh}>
                  <Icon name="terminal" size={14} />
                  <span>Use GitHub CLI session</span>
                </button>
                <div class="connector-or">or paste a token</div>
              </>
            ) : null}
            <label class="connector-connect-field">
              <span class="connector-connect-label">Personal access token</span>
              <p class="connector-connect-hint">
                {provider.tokenHint}{" "}
                {provider.tokenHelpUrl ? (
                  <a class="connector-help-link" href={provider.tokenHelpUrl} target="_blank" rel="noreferrer">
                    Where do I get this?
                  </a>
                ) : null}
              </p>
              <input
                class="input connector-token-input"
                type="password"
                autocomplete="off"
                placeholder="Paste token here"
                value={token}
                onInput={(event) => setToken((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <div>
              <button
                class="btn btn-primary"
                type="button"
                data-provider={provider.id}
                onClick={() => {
                  const trimmed = token.trim();
                  if (!trimmed) {
                    toast("Paste a token first.", { tone: "error" });
                    return;
                  }
                  onConnectToken(provider.id, trimmed);
                }}
              >
                <Icon name="check" size={14} />
                <span>Connect with token</span>
              </button>
            </div>
          </div>
          <div class="connector-info-strip">
            <span dangerouslySetInnerHTML={{ __html: icon("activity", 15) }} />
            <span>
              Once connected, {provider.displayName} issues can be imported and auto-bound to local repos under your
              workspace root.
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
