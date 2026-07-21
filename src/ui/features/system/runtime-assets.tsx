import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { api } from "@ui/data/api.js";
import { icon } from "@ui/shell/icons.js";
import { confirm } from "@ui/overlays/confirm.js";
import { errorToast, toast } from "@ui/overlays/toast.js";

interface RuntimeAssetMigrationResult {
  upgraded: { workflows: string[]; skills: string[] };
  pendingReview: { workflows: string[]; skills: string[] };
  untouched: { workflows: string[]; skills: string[] };
  errors: Array<{ kind: "workflow" | "skill"; id: string; message: string }>;
}

interface RuntimeAssetsResponse {
  migration: RuntimeAssetMigrationResult;
}

interface RuntimeAssetDiff {
  kind: "workflow" | "skill";
  id: string;
  status: string;
  bundledBody: string | null;
  runtimeBody: string | null;
  priorBundledBody: string | null;
  bundledHash: string | null;
  runtimeHash: string | null;
  priorBundledHash: string | null;
  installedBundledHash: string | null;
}

interface PendingAsset {
  kind: "workflow" | "skill";
  id: string;
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 12);
}

function DiffBlock({ title, body }: { title: string; body: string | null }) {
  return (
    <div class="runtime-asset-diff-block">
      <div class="runtime-asset-diff-title">{title}</div>
      <pre class="runtime-asset-diff-body">{body ?? "Unavailable"}</pre>
    </div>
  );
}

function PendingAssetRow({
  asset,
  onChanged
}: {
  asset: PendingAsset;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<RuntimeAssetDiff | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadDiff(): Promise<void> {
    try {
      const next = await api<RuntimeAssetDiff>(`/api/runtime-assets/${asset.kind}/${asset.id}/diff`);
      setDiff(next);
      setOpen(true);
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  async function keepAsset(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/runtime-assets/${asset.kind}/${asset.id}/keep`, { method: "POST" });
      toast(`Kept customized ${asset.kind} "${asset.id}".`, { tone: "success" });
      await onChanged();
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAsset(): Promise<void> {
    const ok = await confirm({
      title: `Reset ${asset.kind}?`,
      message: `Replace runtime "${asset.id}" with the latest bundled copy. A backup is saved first.`,
      confirmLabel: "Reset to bundled"
    });
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api(`/api/runtime-assets/${asset.kind}/${asset.id}/reset`, { method: "POST" });
      toast(`Reset ${asset.kind} "${asset.id}" to bundled.`, { tone: "success" });
      setOpen(false);
      setDiff(null);
      await onChanged();
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="runtime-asset-row">
      <div class="runtime-asset-row-head">
        <span class="catalog-badge">{asset.kind}</span>
        <code>{asset.id}</code>
        <div class="runtime-asset-row-actions">
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadDiff()}>
            View diff
          </button>
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => void keepAsset()}>
            Keep
          </button>
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resetAsset()}>
            Reset
          </button>
        </div>
      </div>
      {open && diff ? (
        <div class="runtime-asset-diff-grid">
          <DiffBlock title={`Prior bundled (${shortHash(diff.priorBundledHash)})`} body={diff.priorBundledBody} />
          <DiffBlock title={`Runtime (${shortHash(diff.runtimeHash)})`} body={diff.runtimeBody} />
          <DiffBlock title={`Current bundled (${shortHash(diff.bundledHash)})`} body={diff.bundledBody} />
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: ComponentChildren;
}) {
  return (
    <section class="project-panel runtime-assets-panel">
      <div class="project-section-head">
        <div>
          <h2>{title}</h2>
          <span class="muted">{subtitle}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

export function RuntimeAssetsPanel() {
  const [migration, setMigration] = useState<RuntimeAssetMigrationResult | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const data = await api<RuntimeAssetsResponse>("/api/runtime-assets");
      setMigration(data?.migration ?? null);
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const pending: PendingAsset[] = [
    ...(migration?.pendingReview.workflows ?? []).map((id) => ({ kind: "workflow" as const, id })),
    ...(migration?.pendingReview.skills ?? []).map((id) => ({ kind: "skill" as const, id }))
  ];

  return (
    <Section
      title="Runtime asset updates"
      subtitle="Review bundled workflow and skill changes before they overwrite local customizations."
    >
      {loading ? (
        <div class="empty-state">Loading runtime asset status…</div>
      ) : pending.length === 0 ? (
        <div class="empty-state">
          <Icon name="check-circle" size={18} /> No bundled assets are waiting for review.
        </div>
      ) : (
        <div class="runtime-asset-list">
          {pending.map((asset) => (
            <PendingAssetRow key={`${asset.kind}:${asset.id}`} asset={asset} onChanged={refresh} />
          ))}
        </div>
      )}
    </Section>
  );
}
