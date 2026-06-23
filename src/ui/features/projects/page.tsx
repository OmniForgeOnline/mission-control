import { useEffect, useRef, useState } from "preact/hooks";
import { render } from "preact";

import { api } from "@ui/data/api.js";
import { ui, relativeTime, type ProjectTab } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { uiLegacyStatus } from "@ui/app/task-status.js";
import { $, onEnterSubmit } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { AttachmentInput } from "@ui/shared/components/attachments.js";
import { AutonomyPanel } from "@ui/features/autonomy/page.js";
import { MemoryPanel } from "@ui/features/memory/page.js";
import { QualityPanel } from "@ui/features/quality/page.js";
import { RunsPanel } from "@ui/features/runs/page.js";
import {
  DEFAULT_TICKET_FILTER,
  filterProjectTickets,
  projectTicketStatuses,
  type TicketTableFilter
} from "@ui/features/projects/ticket-table.js";
import type { HarnessAttachment, IntakeSession, ProjectSummary, QuickStart, QuickstartsFile } from "@ui/app/types.js";

let projectHost: HTMLElement | null = null;

const PROJECT_TAB_DEFS: Array<{ id: ProjectTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
  { id: "autonomy", label: "Autonomy" },
  { id: "memory", label: "Memory" },
  { id: "quality", label: "Quality" }
];

type IntakeQueueItem = NonNullable<IntakeSession["queue"]>[number];

/** Position of the first [bracketed] slot in a quick-start prompt, so the caret
 * lands where the operator fills in specifics. Falls back to end-of-text. */
function firstSlotRange(prompt: string): { start: number; end: number } {
  const match = prompt.match(/\[[^\]]+\]/);
  if (match && match.index !== undefined) {
    return { start: match.index, end: match.index + match[0].length };
  }
  return { start: prompt.length, end: prompt.length };
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function ProjectIntake({ project }: { project: ProjectSummary }) {
  const [session, setSession] = useState<IntakeSession | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<HarnessAttachment[]>([]);
  const [quickstarts, setQuickstarts] = useState<QuickstartsFile | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const notified = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  function notifyQueue(items: IntakeQueueItem[]): void {
    for (const item of items) {
      if (item.status !== "completed" && item.status !== "failed") continue;
      if (notified.current.has(item.id)) continue;
      notified.current.add(item.id);
      if (!primed.current) continue;
      if (item.status === "completed" && item.taskId) {
        const taskId = item.taskId;
        toast("Ticket opened", {
          tone: "success",
          action: { label: "View ticket", onClick: () => navigate("task", taskId) }
        });
      } else if (item.status === "failed") {
        errorToast(item.error ?? "Classification failed");
      }
    }
    primed.current = true;
  }

  async function loadSession(): Promise<void> {
    const next = await api<IntakeSession>(`/api/projects/${project.id}/intake/session`);
    if (!next) return;
    notifyQueue(next.queue ?? []);
    setSession(next);
  }

  async function loadQuickstarts(): Promise<void> {
    const next = await api<QuickstartsFile>(`/api/projects/${project.id}/quickstarts`);
    if (next) setQuickstarts(next);
  }

  useEffect(() => {
    notified.current = new Set();
    primed.current = false;
    setQuickstarts(null);
    void loadSession();
    void loadQuickstarts();
  }, [project.id]);

  // Poll while the tailored set is still being generated in the background.
  useEffect(() => {
    if (quickstarts?.status !== "generating") return;
    const timer = window.setInterval(() => void loadQuickstarts(), 1500);
    return () => window.clearInterval(timer);
  }, [quickstarts?.status, project.id]);

  // Poll while a request is classifying so the opened ticket surfaces as a toast.
  useEffect(() => {
    const active = (session?.queue ?? []).some(
      (item) => item.status === "pending" || item.status === "running"
    );
    if (!active) return;
    const timer = window.setInterval(() => void loadSession(), 1500);
    return () => window.clearInterval(timer);
  }, [session]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    // Block while attachments are still uploading, or a fast submit drops the
    // just-chosen files (their ids are not on `attachments` yet).
    if (!text || sending || uploading) return;
    const attachmentIds = attachments.map((attachment) => attachment.id);
    setSending(true);
    try {
      const result = await api<{ session?: IntakeSession }>(
        `/api/projects/${project.id}/intake/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body: text,
            ...(attachmentIds.length ? { attachmentIds } : {})
          })
        }
      );
      // Drop the draft and attachments only once the message is enqueued;
      // clearing earlier orphans uploaded blobs on a transient failure.
      setDraft("");
      setAttachments([]);
      if (result?.session) {
        notifyQueue(result.session.queue ?? []);
        setSession(result.session);
      }
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      toast(`Project intake error: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: Event): void {
    event.preventDefault();
    void submit();
  }

  function seedDraft(prompt: string): void {
    setDraft(prompt);
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the first [slot] once the controlled value has applied, so the
    // operator can type over it; fall back to the end when there is no slot.
    const { start, end } = firstSlotRange(prompt);
    window.requestAnimationFrame(() => {
      el.selectionStart = start;
      el.selectionEnd = end;
    });
  }

  const active = (session?.queue ?? []).filter(
    (item) => item.status === "pending" || item.status === "running"
  );

  return (
    <section class="project-intake">
      <div class="project-section-head">
        <h2>New conversation</h2>
        <span class="muted">Tickets created here are scoped to {project.name}.</span>
      </div>
      {active.length ? (
        <div class="project-intake-queue">
          {active.slice(-3).map((item) => (
            <div class={`intake-request-card intake-queue-${item.status}`} key={item.id}>
              <div class="message-running">
                <span class="dot" />
                {item.status === "pending"
                  ? "Waiting to classify"
                  : item.activity ?? "Classifying request"}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <form class="intake-composer" onSubmit={(event) => void handleSubmit(event)}>
        <textarea
          class="textarea intake-input"
          id="intakeInput"
          ref={inputRef}
          rows={3}
          placeholder={`Describe work for ${project.name}...`}
          value={draft}
          onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onEnterSubmit(() => void submit())}
        />
        <div class="intake-composer-bar">
          <AttachmentInput
            value={attachments}
            onChange={setAttachments}
            source="intake"
            onUploadingChange={setUploading}
          />
          <div class="intake-composer-actions">
            <span class="intake-composer-hint">
              <kbd>↵</kbd> to send
            </span>
            <button
              class="btn btn-primary intake-submit-button"
              type="submit"
              disabled={sending || uploading}
              aria-label={sending ? "Sending" : uploading ? "Uploading files" : "Send"}
              title={sending ? "Sending" : uploading ? "Uploading files" : "Send"}
            >
              <Icon name="arrow-up" size={17} />
            </button>
          </div>
        </div>
      </form>
      {!active.length && !draft.trim() ? (
        <div class="intake-quickstart">
          <span class="intake-quickstart-label">
            {quickstarts?.status === "generating" ? "Tailoring quick starts…" : "Quick start"}
          </span>
          {(quickstarts?.quickstarts ?? []).map((item: QuickStart) => (
            <button
              class="intake-chip"
              type="button"
              key={item.label}
              title={item.prompt}
              onClick={() => seedDraft(item.prompt)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProjectOverview({ project }: { project: ProjectSummary }) {
  const allTasks = (ui.data?.tasks ?? []).filter((task) => task.projectId === project.id);
  const [filter, setFilter] = useState<TicketTableFilter>(DEFAULT_TICKET_FILTER);
  const statuses = projectTicketStatuses(allTasks);
  const rows = filterProjectTickets(allTasks, filter);

  return (
    <>
      <ProjectIntake project={project} />
      <section class="project-tickets">
        <div class="project-section-head">
          <h2>Tickets</h2>
          <span class="muted">{allTasks.length ? `${allTasks.length} scoped` : "No tickets"}</span>
        </div>
        {allTasks.length ? (
          <>
            <div class="ticket-table-filters">
              <input
                class="input ticket-filter-name"
                type="search"
                placeholder="Filter by name"
                aria-label="Filter tickets by name"
                value={filter.name}
                onInput={(event) =>
                  setFilter({ ...filter, name: (event.currentTarget as HTMLInputElement).value })
                }
              />
              <select
                class="select ticket-filter-status"
                aria-label="Filter tickets by status"
                value={filter.status}
                onChange={(event) =>
                  setFilter({ ...filter, status: (event.currentTarget as HTMLSelectElement).value })
                }
              >
                <option value="all">All statuses</option>
                {statuses.map((status) => (
                  <option value={status} key={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            {rows.length ? (
              <table class="project-ticket-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <button
                        class="ticket-sort-toggle"
                        type="button"
                        onClick={() =>
                          setFilter({
                            ...filter,
                            sort: filter.sort === "updated-desc" ? "updated-asc" : "updated-desc"
                          })
                        }
                      >
                        <span>Updated</span>
                        <span
                          class={`ticket-sort-caret${filter.sort === "updated-asc" ? " is-asc" : ""}`}
                        >
                          <Icon name="chevron-down" size={12} />
                        </span>
                      </button>
                    </th>
                    <th scope="col">Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((task) => (
                    <tr class="project-ticket-row" key={task.id}>
                      <td>
                        <button
                          class="ticket-link"
                          type="button"
                          onClick={() => navigate("task", task.id)}
                        >
                          {task.title}
                        </button>
                      </td>
                      <td>
                        <span class="ticket-status-badge" data-status={uiLegacyStatus(task)}>
                          <span class="dot" />
                          {uiLegacyStatus(task)}
                        </span>
                      </td>
                      <td class="ticket-updated">{relativeTime(task.updatedAt)}</td>
                      <td class="ticket-branch">{task.branch ? task.branch : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="empty-state">
                <h3>No matching tickets</h3>
                <p>Adjust the filters to see more tickets.</p>
              </div>
            )}
          </>
        ) : (
          <div class="empty-state">
            <h3>No tickets</h3>
            <p>Create a project conversation above to open the first scoped ticket.</p>
          </div>
        )}
      </section>
    </>
  );
}

function ProjectTabPanel({ project, tab }: { project: ProjectSummary; tab: ProjectTab }) {
  if (tab === "runs") {
    return <RunsPanel projectId={project.id} />;
  }
  if (tab === "autonomy") {
    return <AutonomyPanel scope={{ kind: "project", projectId: project.id }} />;
  }
  if (tab === "memory") {
    return <MemoryPanel projectId={project.id} />;
  }
  if (tab === "quality") {
    return <QualityPanel projectId={project.id} />;
  }
  return <ProjectOverview project={project} />;
}

function ProjectView({ project }: { project: ProjectSummary }) {
  const activeTab = ui.projectTab;

  return (
    <div class="view project-view" id="projectView">
      <header class="view-header project-header">
        <div>
          <h1 class="view-title">{project.name}</h1>
          <p class="view-subtitle">{project.repoPath}</p>
        </div>
        <span
          class="badge project-status-badge"
          data-tone={project.status === "paused" ? "paused" : "running"}
        >
          <span class="dot" />
          {project.status}
        </span>
      </header>
      <nav class="project-tabs" role="tablist">
        {PROJECT_TAB_DEFS.map((def) => (
          <button
            key={def.id}
            type="button"
            role="tab"
            aria-selected={activeTab === def.id ? "true" : "false"}
            class={`project-tab${activeTab === def.id ? " active" : ""}`}
            onClick={() => navigate("project", project.id, { projectTab: def.id })}
          >
            {def.label}
          </button>
        ))}
      </nav>
      <ProjectTabPanel project={project} tab={activeTab} key={project.id} />
    </div>
  );
}

function mountProject(): void {
  const root = $("#viewContent");
  if (!root) return;
  projectHost = root;
  const project = (ui.data?.projects ?? []).find((candidate) => candidate.id === ui.taskId);
  if (!project) {
    render(
      <div class="view">
        <div class="empty-state">
          <h3>Project not found</h3>
          <p>The selected project is no longer registered.</p>
        </div>
      </div>,
      root
    );
    return;
  }
  render(<ProjectView project={project} />, root);
}

export function updateProjectView(): void {
  if (!projectHost || !$("#projectView")) {
    renderProjectView();
    return;
  }
  mountProject();
}

export function renderProjectView(): void {
  mountProject();
}
