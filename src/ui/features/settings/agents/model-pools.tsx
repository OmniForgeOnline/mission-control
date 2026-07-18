import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import type { ModelPoolConfig } from "../../../../core/agents/config/types.ts";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

/** Model id from launch args for a quiet secondary line (e.g. `--model glm-5.2`). */
function poolModelId(pool: ModelPoolConfig): string | undefined {
  const args = pool.modelArgs;
  const idx = args.indexOf("--model");
  if (idx >= 0 && typeof args[idx + 1] === "string") return args[idx + 1];
  return args.length ? args.join(" ") : undefined;
}

/**
 * One model row: name (+ optional model id) and an enable toggle.
 * Routing knobs (tier, quality, capabilities) stay in config but are not operator surface.
 * Off = hidden from step model dropdowns and skipped by the router.
 */
export function PoolRow({ pool }: { pool: ModelPoolConfig }) {
  const [busy, setBusy] = useState(false);
  const modelId = poolModelId(pool);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await api("/api/agent-config/pools", {
        method: "PUT",
        body: JSON.stringify({ ...pool, enabled: !pool.enabled })
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update model.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class={`pool-row${pool.enabled ? "" : " is-disabled"}`}>
      <div class="pool-id">
        <span class="pool-name">{pool.displayName}</span>
        {modelId && modelId !== pool.displayName ? <span class="pool-model-id">{modelId}</span> : null}
      </div>
      <label
        class="settings-switch"
        title={pool.enabled ? "Shown in step model dropdown" : "Hidden from step model dropdown"}
      >
        <input type="checkbox" checked={pool.enabled} disabled={busy} onChange={() => void toggle()} />
        <span class="settings-switch-track" />
      </label>
    </li>
  );
}

/** Add a model entry (pool) to a tool. model id becomes `--model <id>`; the
 * optional env JSON covers custom providers (e.g. z.ai on claude: base URL + token). */
export function AddModelForm({ toolId }: { toolId: string }) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelEnvRaw, setModelEnvRaw] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    const name = displayName.trim();
    const id = modelId.trim();
    if (!name || !id) {
      toast("Display name and model id are required.", { tone: "error" });
      return;
    }
    let modelEnv: Record<string, string> = {};
    if (modelEnvRaw.trim()) {
      try {
        const parsed = JSON.parse(modelEnvRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        modelEnv = parsed as Record<string, string>;
      } catch {
        toast(
          'Model env must be a JSON object, e.g. {"ANTHROPIC_BASE_URL":"https://...","ANTHROPIC_AUTH_TOKEN":"..."}',
          { tone: "error" }
        );
        return;
      }
    }
    setBusy(true);
    try {
      // Pool ids must be alphanumeric (._-). Model ids can contain other chars
      // (e.g. the [1m] context suffix), so slugify the id while preserving the
      // exact model id verbatim in --model.
      const slug = id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || id;
      await api("/api/agent-config/pools", {
        method: "PUT",
        body: JSON.stringify({
          id: `${toolId}-${slug}`,
          toolId,
          displayName: name,
          modelArgs: ["--model", id],
          modelEnv,
          // Routing defaults: not exposed in the form; operators only pick models to offer.
          capabilities: ["author", "reviewer", "code", "plan", "review"],
          qualityWeight: 50,
          tier: "paid",
          usage: { kind: "usage-only" },
          usageSource: "none",
          enabled: true,
          builtin: false
        })
      });
      toast(`Added model "${name}".`, { tone: "success" });
      setDisplayName("");
      setModelId("");
      setModelEnvRaw("");
      setOpen(false);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add model.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button class="btn btn-sm btn-ghost" type="button" onClick={() => setOpen(true)}>
        + Add model
      </button>
    );
  }
  return (
    <div class="model-add-form">
      <input
        class="input"
        type="text"
        placeholder="Display name (e.g. GLM 5.2)"
        value={displayName}
        disabled={busy}
        onInput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)}
      />
      <input
        class="input"
        type="text"
        placeholder="Model id (e.g. glm-5.2) — passed to --model"
        value={modelId}
        disabled={busy}
        onInput={(e) => setModelId((e.currentTarget as HTMLInputElement).value)}
      />
      <input
        class="input model-add-env"
        type="text"
        placeholder='Optional env JSON: {"ANTHROPIC_BASE_URL":"https://...","ANTHROPIC_AUTH_TOKEN":"..."}'
        value={modelEnvRaw}
        disabled={busy}
        onInput={(e) => setModelEnvRaw((e.currentTarget as HTMLInputElement).value)}
      />
      <div class="model-add-actions">
        <button class="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => void add()}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button class="btn btn-sm" type="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
