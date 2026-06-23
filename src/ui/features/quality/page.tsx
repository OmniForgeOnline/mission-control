import type { QualityFile } from "@ui/app/types.js";

type QualityDomain = NonNullable<QualityFile["domains"]>[string];
import { useEffect, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { withPending } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { relativeTime } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function GradeCard({ name, grade }: { name: string; grade: QualityDomain }) {
  return (
    <div class="grade-card">
      <div class="row" style="justify-content:space-between">
        <strong>{name}</strong>
        <span class={`grade grade-${grade.grade}`}>{grade.grade}</span>
      </div>
      <div class="muted" style="font-size:var(--t-sm)">
        {grade.rationale ?? ""}
      </div>
      <div class="meta-line" style="font-size:var(--t-xs);color:var(--ink-faint)">
        {(grade.evidence ?? []).map((entry) => (
          <span class="chip mono" key={entry}>
            {entry}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Quality grades for a single project. Reads and recomputes via the
 * per-project quality routes; the built-in Mission Control project maps to the
 * global quality file server-side.
 */
export function QualityPanel({ projectId }: { projectId: string }) {
  const [quality, setQuality] = useState<QualityFile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function load(showLoading: boolean): Promise<void> {
      if (showLoading) setLoading(true);
      const q = await api<QualityFile>(`/api/projects/${projectId}/quality`);
      if (!active) return;
      setQuality(q ?? { domains: {} });
      setLoading(false);
    }

    void load(true);

    // Refetch on app refreshes (e.g. scheduled autonomy recomputes) so grades
    // stay current even while the project view is mounted with the same id.
    const onRefresh = (): void => void load(false);
    document.addEventListener("harness:refresh", onRefresh);

    return () => {
      active = false;
      document.removeEventListener("harness:refresh", onRefresh);
    };
  }, [projectId]);

  async function handleRecompute(): Promise<void> {
    const q = await api<QualityFile>(`/api/projects/${projectId}/quality/recompute`, {
      method: "POST"
    });
    if (q) setQuality(q);
    toast("Quality grades recomputed.");
  }

  const domains = quality?.domains ?? {};
  const entries = Object.entries(domains);

  return (
    <section class="project-panel project-panel-quality">
      <div class="project-section-head">
        <div>
          <h2>Quality</h2>
          <span class="muted">
            Per-domain grades. Last computed{" "}
            {quality?.updatedAt ? relativeTime(quality.updatedAt) : "never"}.
          </span>
        </div>
        <button
          class="btn"
          type="button"
          id="recompute"
          onClick={(e) => void withPending(e.currentTarget as HTMLButtonElement, handleRecompute)}
        >
          <Icon name="refresh" size={14} />
          <span>Recompute</span>
        </button>
      </div>
      {loading ? <p class="muted">Loading grades…</p> : null}
      {!loading && entries.length === 0 ? (
        <div class="empty-state">
          <h3>No grades yet</h3>
          <p>Run "Recompute" to generate them.</p>
        </div>
      ) : null}
      <div class="cards-grid">
        {entries.map(([name, grade]) => (
          <GradeCard key={name} name={name} grade={grade} />
        ))}
      </div>
    </section>
  );
}
