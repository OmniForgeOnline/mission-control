import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { withPending } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { ui, relativeTime } from "@ui/app/state.js";
import { confirm } from "@ui/overlays/confirm.js";
import { toast } from "@ui/overlays/toast.js";
import type { MemoryPage } from "@ui/app/types.js";
import { isMemoryPage, pageSlug, withoutPage } from "@ui/features/memory/match.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function MemoryPageRow({
  page,
  projectId,
  onRemoved
}: {
  page: MemoryPage;
  projectId: string;
  onRemoved: (slug: string) => void;
}) {
  const slug = pageSlug(page);
  const scope = page.projectId ?? projectId;
  // Index-search rows can also surface tasks/runs/files, which have no memory
  // page to open or delete. Only memory-backed rows get those affordances.
  const canManage = isMemoryPage(page);

  async function handleOpen(): Promise<void> {
    if (!canManage) return;
    const loaded = await api<MemoryPage>(
      `/api/memory/pages/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(scope)}`
    );
    if (loaded) {
      document.dispatchEvent(new CustomEvent("harness:open-memory", { detail: loaded }));
    }
  }

  async function handleRemove(): Promise<void> {
    const ok = await confirm({
      title: "Remove memory?",
      message: `Remove "${page.title}" (${slug}). This is irreversible.`,
      confirmLabel: "Remove",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/memory/pages/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(scope)}`, {
        method: "DELETE"
      });
      toast(`Memory "${page.title}" removed.`, { tone: "success" });
      onRemoved(slug);
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove memory.", { tone: "error" });
    }
  }

  return (
    <div
      class="task-row"
      data-open-page={slug}
      onClick={canManage ? () => void handleOpen() : undefined}
    >
      <span />
      <div class="body">
        <div class="title-line">
          <span class="title">{page.title}</span>
        </div>
        <div class="description">{page.snippet ?? page.content?.slice(0, 200) ?? ""}</div>
        <div class="meta-line" style="margin-top:6px">
          <span class="chip mono">{slug}</span>
          {page.type ? <span>{page.type}</span> : null}
          {(page.tags ?? []).map((tag) => (
            <span class="chip" key={tag}>
              {tag}
            </span>
          ))}
          {page.updatedAt ? <span>{relativeTime(page.updatedAt)}</span> : null}
          {page.score ? <span>score {page.score}</span> : null}
        </div>
      </div>
      <span />
      <div class="row-actions">
        {canManage ? (
          <button
            class="btn btn-icon btn-ghost"
            type="button"
            title="Remove memory"
            aria-label={`Remove memory ${slug}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleRemove();
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Memory wiki for a single project. Pages live under that project's state dir
 * and both the default listing and search are scoped to the project so nothing
 * from another project leaks into the tab.
 */
export function MemoryPanel({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryPage[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);

  const allPages = ui.data?.memoryPages ?? [];
  const scopedPages = allPages.filter((page) => page.projectId === projectId);
  const pages = searchResults ?? scopedPages;

  // While a search is active, rendered rows come from local searchResults rather
  // than ui.data.memoryPages, so the global refresh alone can't remove a deleted
  // page. Drop it locally so the list reflects deletion immediately.
  function handleRemoved(slug: string): void {
    setSearchResults((prev) => (prev ? withoutPage(prev, slug) : prev));
  }

  async function runSearch(value?: string): Promise<void> {
    const trimmed = (value ?? query).trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearchPending(false);
      return;
    }
    setSearchPending(true);
    const results = await api<MemoryPage[]>(
      `/api/memory/index/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(trimmed)}`
    );
    setSearchResults(results ?? []);
    setSearchPending(false);
  }

  function handleClear(): void {
    setSearchResults(null);
    setQuery("");
  }

  async function handleRebuildIndex(): Promise<void> {
    const r = await api<{ documents: unknown[] }>("/api/memory/index/rebuild", {
      method: "POST",
      body: JSON.stringify({ projectId, targetPaths: [] })
    });
    if (r) {
      toast(`Rebuilt index: ${r.documents.length} document(s).`, { tone: "success" });
      setSearchResults(null);
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    }
  }

  function handleCapture(): void {
    document.dispatchEvent(
      new CustomEvent("harness:capture-memory", { detail: { projectId } })
    );
  }

  return (
    <section class="project-panel project-panel-memory">
      <div class="project-section-head">
        <div>
          <h2>Memory</h2>
          <span class="muted">
            Durable wiki for this project (gitignored, local only). Search is scoped to this project.
          </span>
        </div>
        <div class="view-actions">
          <button
            class="btn"
            type="button"
            onClick={(e) =>
              void withPending(e.currentTarget as HTMLButtonElement, handleRebuildIndex)
            }
          >
            <Icon name="refresh" size={14} />
            <span>Rebuild index</span>
          </button>
          <button class="btn btn-primary" type="button" onClick={handleCapture}>
            <Icon name="plus" size={14} />
            <span>Capture</span>
          </button>
        </div>
      </div>
      <div class="row">
        <div class="field" style="flex:1;min-width:240px">
          <input
            class="input"
            id="memSearch"
            placeholder="Search memory… ('python testing')"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              const e = event as KeyboardEvent;
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
        </div>
        <button
          class="btn"
          type="button"
          onClick={(e) => void withPending(e.currentTarget as HTMLButtonElement, () => runSearch())}
        >
          <Icon name="search" size={14} />
          <span>Search</span>
        </button>
        {searchResults ? (
          <button class="btn btn-ghost" type="button" onClick={handleClear}>
            <Icon name="x" size={14} />
            <span>Clear</span>
          </button>
        ) : null}
      </div>
      {searchPending ? <p class="muted">Searching…</p> : null}
      {pages.length === 0 ? (
        <div class="empty-state">
          <h3>No memory yet</h3>
          <p>No pages captured for this project yet.</p>
        </div>
      ) : null}
      <div class="task-list">
        {pages.map((page) => (
          <MemoryPageRow
            key={page.slug ?? page.path ?? page.title}
            page={page}
            projectId={projectId}
            onRemoved={handleRemoved}
          />
        ))}
      </div>
    </section>
  );
}
