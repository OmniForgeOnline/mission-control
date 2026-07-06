import { useEffect, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { icon } from "@ui/shell/icons.js";
import { relativeTime } from "@ui/app/state.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import type {
  QualityGateFile,
  QualityGateStatus,
  QualityGateCheck,
  CheckResult,
  CheckResultStatus,
  CheckRunSummary
} from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

/** Map each gate status onto an existing badge tone so no new CSS palette is needed. */
const STATUS_TONE: Record<QualityGateStatus, string> = {
  pending: "backlog",
  generating: "in_progress",
  ready: "done",
  incomplete: "awaiting_operator",
  failed: "rejected"
};

const STATUS_LABEL: Record<QualityGateStatus, string> = {
  pending: "Pending",
  generating: "Generating…",
  ready: "Ready",
  incomplete: "Incomplete",
  failed: "Failed"
};

/** Tone + label for an on-demand check result, reusing existing badge tones. */
const CHECK_RESULT_TONE: Record<CheckResultStatus, { tone: string; label: string }> = {
  passed: { tone: "done", label: "Passed" },
  failed: { tone: "rejected", label: "Failed" },
  skipped: { tone: "backlog", label: "Skipped" }
};

const CATEGORIES = ["lint", "test", "typecheck", "build", "format", "security", "other"];

interface Draft {
  name: string;
  command: string;
  category: string;
  required: boolean;
}

/** Inline editor for one check (add or edit). Controlled by the parent's draft state. */
function CheckEditForm(props: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { draft, setDraft, onSave, onCancel, saving, error } = props;
  const field = (key: keyof Draft, value: string | boolean): void => setDraft({ ...draft, [key]: value });
  return (
    <div class="gate-check gate-check-editing">
      <input
        class="gate-check-input"
        type="text"
        placeholder="name (e.g. lint)"
        value={draft.name}
        onInput={(e) => field("name", (e.currentTarget as HTMLInputElement).value)}
      />
      <input
        class="gate-check-input mono"
        type="text"
        placeholder="command (e.g. npm run lint)"
        value={draft.command}
        onInput={(e) => field("command", (e.currentTarget as HTMLInputElement).value)}
      />
      <div class="row" style="gap:var(--s-2);align-items:center">
        <select
          class="gate-check-select"
          value={draft.category}
          onChange={(e) => field("category", (e.currentTarget as HTMLSelectElement).value)}
        >
          {CATEGORIES.map((c) => (
            <option value={c} key={c}>
              {c}
            </option>
          ))}
        </select>
        <label class="gate-check-required">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(e) => field("required", (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="muted">required</span>
        </label>
        <div style="margin-left:auto;display:flex;gap:var(--s-2)">
          <button class="btn btn-sm" type="button" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button class="btn btn-sm btn-primary" type="button" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {error ? <p class="quality-gate-error">{error}</p> : null}
    </div>
  );
}

/**
 * A project's generated quality-gate config, with a Regenerate action. Covers the
 * "retrigger" cases: a failed generation, a changed repo (new/removed commands), or
 * a project onboarded before this feature existed. Regenerate is fire-and-forget on
 * the server (it returns `generating`), so we poll GET until the gate reaches a
 * terminal state — the same loop quickstarts uses.
 */
export function QualityGatePanel({ projectId }: { projectId: string }) {
  const [gate, setGate] = useState<QualityGateFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [runningOne, setRunningOne] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [editing, setEditing] = useState<{ isNew: boolean; originalName: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", command: "", category: "test", required: true });
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load(): Promise<void> {
    const next = await api<QualityGateFile>(`/api/projects/${projectId}/quality-gate`);
    if (next) setGate(next);
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    void load();
  }, [projectId]);

  // Poll while generating — the regenerate route is fire-and-forget in prod.
  useEffect(() => {
    if (gate?.status !== "generating") return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [gate?.status, projectId]);

  async function handleRegenerate(): Promise<void> {
    setRegenerating(true);
    try {
      const next = await api<QualityGateFile>(
        `/api/projects/${projectId}/quality-gate/regenerate`,
        { method: "POST" }
      );
      if (next) setGate(next);
      toast("Regenerating quality gate…");
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setRegenerating(false);
    }
  }

  function mergeResults(summary: CheckRunSummary | null): void {
    if (!summary) return;
    const next: Record<string, CheckResult> = {};
    for (const result of summary.results) next[result.name] = result;
    setResults(next);
  }

  async function handleRunAll(): Promise<void> {
    setRunningAll(true);
    try {
      mergeResults(
        await api<CheckRunSummary>(`/api/projects/${projectId}/quality-gate/run`, { method: "POST" })
      );
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setRunningAll(false);
    }
  }

  async function handleRunOne(name: string): Promise<void> {
    setRunningOne(name);
    try {
      const summary = await api<CheckRunSummary>(`/api/projects/${projectId}/quality-gate/run`, {
        method: "POST",
        body: JSON.stringify({ check: name })
      });
      const result = summary?.results[0];
      if (result) {
        setResults((prev) => ({ ...prev, [name]: result }));
      }
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setRunningOne(null);
    }
  }

  const status: QualityGateStatus = gate?.status ?? "pending";
  const generating = status === "generating";
  const checks = gate?.checks ?? [];

  function beginEdit(check: QualityGateCheck): void {
    setEditing({ isNew: false, originalName: check.name });
    setDraft({ name: check.name, command: check.command, category: check.category, required: check.required });
    setEditError(null);
  }
  function beginAdd(): void {
    setEditing({ isNew: true, originalName: "" });
    setDraft({ name: "", command: "", category: "test", required: true });
    setEditError(null);
  }
  function cancelEdit(): void {
    setEditing(null);
    setEditError(null);
  }

  /** PUT the full checks array (the source of truth after an edit/remove/add). */
  async function putChecks(nextChecks: QualityGateCheck[]): Promise<void> {
    setSaving(true);
    setEditError(null);
    try {
      const updated = await api<QualityGateFile>(`/api/projects/${projectId}/quality-gate/checks`, {
        method: "PUT",
        body: JSON.stringify({ checks: nextChecks })
      });
      if (updated) {
        setGate(updated);
        setResults({}); // run results are stale after a check-set change
      }
      setEditing(null);
    } catch (err) {
      setEditError((err as Error).message);
      errorToast((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function saveEdit(): void {
    if (!editing || !gate) return;
    const trimmed: QualityGateCheck = {
      name: draft.name.trim(),
      command: draft.command.trim(),
      category: draft.category,
      required: draft.required,
      evidence: []
    };
    const replaced = gate.checks.map((c) =>
      c.name === editing.originalName ? { ...c, ...trimmed } : c
    );
    const nextChecks = editing.isNew ? [...gate.checks, trimmed] : replaced;
    void putChecks(nextChecks);
  }

  function removeCheck(name: string): void {
    if (!gate) return;
    void putChecks(gate.checks.filter((c) => c.name !== name));
  }

  return (
    <section class="project-panel project-panel-quality-gate">
      <div class="project-section-head">
        <div>
          <h2>Quality gate</h2>
          <span class="muted">
            Project-specific checks the gate runs.
            {gate?.generatedAt ? ` Last generated ${relativeTime(gate.generatedAt)}.` : ""}
          </span>
        </div>
        <div class="quality-gate-actions">
          <button
            class="btn"
            type="button"
            disabled={runningAll || generating || regenerating || checks.length === 0}
            aria-label={runningAll ? "Running all checks" : "Run all checks"}
            onClick={() => void handleRunAll()}
          >
            <Icon name="play" size={14} />
            <span>{runningAll ? "Running…" : "Run all"}</span>
          </button>
          <button
            class="btn"
            type="button"
            disabled={generating || regenerating}
            aria-label={generating || regenerating ? "Regenerating quality gate" : "Regenerate quality gate"}
            onClick={() => void handleRegenerate()}
          >
            <Icon name="refresh" size={14} />
            <span>{generating || regenerating ? "Regenerating…" : "Regenerate"}</span>
          </button>
        </div>
      </div>

      {loading ? <p class="muted">Loading quality gate…</p> : null}

      {!loading && gate ? (
        <>
          <div class="quality-gate-status">
            <span class="badge" data-tone={STATUS_TONE[status]}>
              {STATUS_LABEL[status]}
            </span>
            {checks.length > 0 ? (
              <span class="muted">
                {checks.length} check{checks.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {status === "failed" && gate.error ? (
            <p class="quality-gate-error">{gate.error}</p>
          ) : null}

          {status === "incomplete" && gate.needsResolution?.length ? (
            <div class="quality-gate-gaps">
              <span class="muted">Needs resolution:</span>
              <ul>
                {gate.needsResolution.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {checks.length > 0 || editing?.isNew ? (
            <div class="cards-grid">
              {checks.map((check) => {
                if (editing && !editing.isNew && editing.originalName === check.name) {
                  return (
                    <CheckEditForm
                      key={`edit:${check.name}`}
                      draft={draft}
                      setDraft={setDraft}
                      onSave={saveEdit}
                      onCancel={cancelEdit}
                      saving={saving}
                      error={editError}
                    />
                  );
                }
                const result = results[check.name];
                const tone = result ? CHECK_RESULT_TONE[result.status] : null;
                const thisCheckRunning = runningOne === check.name;
                return (
                  <div class="gate-check" key={`${check.category}:${check.command}`}>
                    <div class="row" style="justify-content:space-between">
                      <strong>{check.name}</strong>
                      <span class="chip">{check.required ? "required" : "optional"}</span>
                    </div>
                    <code class="gate-check-command mono">{check.command}</code>
                    <div class="meta-line" style="font-size:var(--t-xs);color:var(--ink-faint)">
                      <span class="chip">{check.category}</span>
                      {check.workingDirectory ? (
                        <span class="chip mono">{check.workingDirectory}</span>
                      ) : null}
                      {tone ? (
                        <span class="badge" data-tone={tone.tone}>
                          {tone.label}
                          {result?.status === "failed" && result.exitCode ? ` (exit ${result.exitCode})` : ""}
                        </span>
                      ) : null}
                    </div>
                    {result?.skipReason ? (
                      <p class="quality-gate-error">{result.skipReason}</p>
                    ) : null}
                    {result?.output ? (
                      <details class="gate-check-output">
                        <summary>Output</summary>
                        <pre>{result.output}</pre>
                      </details>
                    ) : null}
                    <div class="gate-check-toolbar">
                      <button
                        class="btn btn-sm"
                        type="button"
                        disabled={thisCheckRunning || runningAll || generating || !!editing}
                        onClick={() => void handleRunOne(check.name)}
                      >
                        {thisCheckRunning ? "Running…" : "Run"}
                      </button>
                      <button
                        class="btn btn-sm btn-ghost"
                        type="button"
                        disabled={!!editing || generating}
                        onClick={() => beginEdit(check)}
                      >
                        Edit
                      </button>
                      <button
                        class="btn btn-sm btn-danger"
                        type="button"
                        disabled={!!editing || generating}
                        onClick={() => removeCheck(check.name)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              {editing?.isNew ? (
                <CheckEditForm
                  key="edit:new"
                  draft={draft}
                  setDraft={setDraft}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                  saving={saving}
                  error={editError}
                />
              ) : null}
            </div>
          ) : null}

          {!editing && !generating && status !== "pending" ? (
            <button class="btn btn-sm" type="button" onClick={beginAdd}>
              + Add check
            </button>
          ) : null}

          {gate.rationale ? <p class="muted quality-gate-rationale">{gate.rationale}</p> : null}
        </>
      ) : null}

      {!loading && !gate ? (
        <div class="empty-state">
          <h3>No quality gate yet</h3>
          <p>Run "Regenerate" to generate one for this project.</p>
        </div>
      ) : null}
    </section>
  );
}
