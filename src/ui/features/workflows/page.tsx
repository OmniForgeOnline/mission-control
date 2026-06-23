import { useEffect, useMemo, useState } from "preact/hooks";
import { render } from "preact";
import type { ComponentChildren } from "preact";

import type { WorkflowDefinition } from "../../../core/workflows/types.ts";
import { groupWorkflowsByCategory } from "../../../core/catalog/workflow-categories.ts";
import { api } from "@ui/data/api.js";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ui } from "@ui/app/state.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";
import { errorToast, toast } from "@ui/overlays/toast.js";
import { WorkflowEditor } from "./editor.js";
import { kindLabel } from "./options.js";
import { WorkflowCanvas } from "../tasks/detail/workflow/canvas.js";

function emptyWorkflow(): WorkflowDefinition {
  return {
    id: "new-workflow",
    name: "New workflow",
    initial: "start",
    defaults: { author: "claude", reviewer: "claude" },
    steps: {
      start: { id: "start", kind: "agent_turn", agent: "author", approval: "required", next: "done" },
      done: { id: "done", kind: "terminal", agent: "none", approval: "none" }
    }
  };
}

/** Stub task for the read-only preview canvas (no live run → all steps upcoming). */
const PREVIEW_TASK = { id: "workflow-preview" } as unknown as HarnessTask;

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function resolveStageAgent(summary: WorkflowSummary, agent: string): string {
  if (agent === "none") return "—";
  if (agent === "author") return summary.defaults.author;
  if (agent === "reviewer") return summary.defaults.reviewer;
  return agent;
}

function Group({
  label,
  count,
  expanded,
  onToggle,
  children
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="catalog-group">
      <button type="button" class="catalog-group-head" aria-expanded={expanded} onClick={onToggle}>
        <span class="catalog-group-chevron">
          <Icon name="chevron-right" size={13} />
        </span>
        <span>{label}</span>
        <span class="catalog-group-count">{count}</span>
      </button>
      {expanded ? children : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="catalog-fact">
      <div class="catalog-fact-k">{label}</div>
      <div class="catalog-fact-v">{children}</div>
    </div>
  );
}

function WorkflowDetail({ summary, onEdit }: { summary: WorkflowSummary; onEdit: () => void }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  return (
    <div class="catalog-detail-inner">
      <header class="catalog-id-head">
        <span class="catalog-id-logo">
          <Icon name="workflow" size={26} />
        </span>
        <div class="catalog-id-text">
          <div class="catalog-id-title-row">
            <h2 class="catalog-id-title">{summary.name}</h2>
            <span class="catalog-badge">{summary.stepIds.length} steps</span>
          </div>
          <p class="catalog-id-account">
            <code>{summary.id}</code> · author {summary.defaults.author} · reviewer {summary.defaults.reviewer}
          </p>
        </div>
        <div class="catalog-id-actions">
          <button class="btn btn-primary" type="button" onClick={onEdit}>
            <Icon name="edit" size={14} />
            <span>Edit workflow</span>
          </button>
        </div>
      </header>

      <div class="wf-detail-split">
        <div class="wf-detail-canvas">
          <WorkflowCanvas
            task={PREVIEW_TASK}
            workflow={summary}
            selectedStepId={selectedStepId}
            onSelectStep={(id) => setSelectedStepId((cur) => (cur === id ? null : id))}
          />
        </div>

        <div class="wf-detail-side">
          <div class="catalog-section-label">Configuration</div>
          <section class="catalog-panel">
            <div class="catalog-panel-body">
              <div class="catalog-facts">
                <Fact label="Start step">
                  <span class="wf-stage-name">{summary.initial}</span>
                </Fact>
                <Fact label="Steps">{summary.stepIds.length}</Fact>
                <Fact label="Author">{summary.defaults.author}</Fact>
                <Fact label="Reviewer">{summary.defaults.reviewer}</Fact>
                <Fact label="Default effort">{summary.defaults.effort ?? "—"}</Fact>
              </div>
            </div>
          </section>

          <div class="catalog-section-label">Stages</div>
          <section class="catalog-panel">
            <table class="wf-stage-table">
              <colgroup>
                <col class="col-stage" />
                <col class="col-kind" />
                <col class="col-agent" />
                <col class="col-approval" />
              </colgroup>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Kind</th>
                  <th>Agent</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {summary.stepIds.map((id) => {
                  const step = summary.steps[id];
                  if (!step) return null;
                  const agent = resolveStageAgent(summary, step.agent);
                  return (
                    <tr
                      key={id}
                      class={selectedStepId === id ? "is-selected" : undefined}
                    >
                      <td>
                        <span class="wf-stage-name">{id}</span>
                      </td>
                      <td>{kindLabel(step.kind)}</td>
                      <td class={agent === "—" ? "wf-stage-muted" : undefined}>{agent}</td>
                      <td class={step.approval === "none" ? "wf-stage-muted" : undefined}>{step.approval}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}

function WorkflowsView() {
  const summaries = (ui.data?.workflows ?? []) as WorkflowSummary[];
  const [editing, setEditing] = useState<{ def: WorkflowDefinition; isNew: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // Start fully collapsed.
    const groups = groupWorkflowsByCategory(summaries);
    return new Set(groups.map((entry) => entry.category.id));
  });

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      summaries.filter(
        (w) => !q || w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q)
      ),
    [summaries, q]
  );
  const groups = useMemo(() => groupWorkflowsByCategory(filtered), [filtered]);

  // Default selection: first workflow.
  useEffect(() => {
    if (selectedId && summaries.some((w) => w.id === selectedId)) return;
    setSelectedId(summaries[0]?.id ?? "");
  }, [summaries, selectedId]);

  const selected = summaries.find((w) => w.id === selectedId);

  function isExpanded(id: string): boolean {
    return Boolean(q) || !collapsed.has(id);
  }

  function toggle(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openEditor(id: string): Promise<void> {
    try {
      const def = await api<WorkflowDefinition>(`/api/workflows/${id}`);
      if (def) setEditing({ def, isNew: false });
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  async function sync(): Promise<void> {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await api<{ synced: string[] }>("/api/workflows/sync", { method: "POST" });
      const count = result?.synced.length ?? 0;
      toast(`Synced ${count} bundled workflow${count === 1 ? "" : "s"} from the latest definitions.`, {
        tone: "success"
      });
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  if (editing) {
    return (
      <WorkflowEditor
        initial={editing.def}
        isNew={editing.isNew}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          document.dispatchEvent(new CustomEvent("harness:refresh"));
        }}
      />
    );
  }

  return (
    <div class="view catalog-view">
      <div class="view-header catalog-view-header">
        <div>
          <h1 class="view-title">Workflows</h1>
          <p class="view-subtitle">
            Browse pipelines and edit them visually. Changes persist to <code>workflows/&#42;.yml</code>.
          </p>
        </div>
        <div class="row">
          <button class="btn" type="button" disabled={syncing} onClick={() => void sync()}>
            <span dangerouslySetInnerHTML={{ __html: icon("refresh", 14) }} />
            <span>{syncing ? "Syncing…" : "Sync workflows"}</span>
          </button>
          <button class="btn btn-primary" type="button" onClick={() => setEditing({ def: emptyWorkflow(), isNew: true })}>
            <span dangerouslySetInnerHTML={{ __html: icon("plus", 14) }} />
            <span>New workflow</span>
          </button>
        </div>
      </div>

      <div class="catalog-shell">
        <aside class="catalog-rail">
          <div class="catalog-search">
            <span class="catalog-search-ico" dangerouslySetInnerHTML={{ __html: icon("search", 14) }} />
            <input
              class="input"
              type="text"
              autocomplete="off"
              placeholder="Search workflows"
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          {groups.map(({ category, workflows }) => (
            <Group
              key={category.id}
              label={category.label}
              count={workflows.length}
              expanded={isExpanded(category.id)}
              onToggle={() => toggle(category.id)}
            >
              {workflows.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  class={`catalog-item${selectedId === w.id ? " is-selected" : ""}`}
                  data-workflow={w.id}
                  aria-pressed={selectedId === w.id}
                  onClick={() => setSelectedId(w.id)}
                >
                  <span class="catalog-item-logo">
                    <Icon name="workflow" size={15} />
                  </span>
                  <span class="catalog-item-meta">
                    <span class="catalog-item-name">{w.name}</span>
                    <span class="catalog-item-sub">
                      {w.id} · {w.stepIds.length} steps
                    </span>
                  </span>
                </button>
              ))}
            </Group>
          ))}

          {!groups.length ? <p class="catalog-empty">No workflows match “{query}”.</p> : null}
        </aside>

        <main class="catalog-detail">
          {selected ? (
            <WorkflowDetail summary={selected} onEdit={() => void openEditor(selected.id)} />
          ) : (
            <p class="catalog-empty">Select a workflow to preview it.</p>
          )}
        </main>
      </div>
    </div>
  );
}

export function renderWorkflowsView(): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<WorkflowsView />, root);
}
