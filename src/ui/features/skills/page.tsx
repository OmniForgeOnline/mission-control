import type { SkillCategoryId } from "../../../core/catalog/skill-categories.ts";
import { groupSkillsByCategory } from "../../../core/catalog/skill-categories.ts";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api } from "@ui/data/api.js";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { renderMarkdown, stripFrontmatter } from "@ui/shared/lib/markdown.js";
import { toast, errorToast } from "@ui/overlays/toast.js";

interface SkillSummary {
  name: string;
  description: string;
  category: SkillCategoryId;
}

interface SkillsResponse {
  skills: SkillSummary[];
  kernelSections: string[];
}

interface SkillBody {
  name: string;
  content: string;
}

type Selection = { kind: "skill"; name: string } | { kind: "kernel"; name: string };

const CATEGORY_ICONS: Record<SkillCategoryId, string> = {
  loop: "workflow",
  platform: "shield",
  engineering: "git-branch",
  domain: "zap",
  other: "sparkles"
};

const KERNEL_GROUP_ID = "__kernel";

let cached: SkillsResponse | null = null;

document.addEventListener("harness:refresh", () => {
  cached = null;
});
document.addEventListener("harness:refresh-render", () => {
  if ($("#skillsView")) cached = null;
});

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)
  );
}

function CatalogItem({
  iconName,
  name,
  sub,
  selected,
  onSelect
}: {
  iconName: string;
  name: string;
  sub: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class={`catalog-item${selected ? " is-selected" : ""}`}
      data-skill={name}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span class="catalog-item-logo">
        <Icon name={iconName} size={15} />
      </span>
      <span class="catalog-item-meta">
        <span class="catalog-item-name">{name}</span>
        <span class="catalog-item-sub">{sub}</span>
      </span>
    </button>
  );
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

function SkillsView({ data, embedded = false }: { data: SkillsResponse; embedded?: boolean }) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // Start fully collapsed: every category group plus the kernel group.
    const ids = new Set<string>([KERNEL_GROUP_ID]);
    for (const skill of data.skills) ids.add(skill.category);
    return ids;
  });
  const [body, setBody] = useState<SkillBody | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const q = query.trim();
  const filteredSkills = filterSkills(data.skills, query);
  const groups = groupSkillsByCategory(filteredSkills);
  const kernelMatches = data.kernelSections.filter(
    (section) => !q || section.toLowerCase().includes(q.toLowerCase())
  );

  function isExpanded(id: string): boolean {
    // A live search force-expands matching groups so a hit is never hidden.
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

  // Default selection: first skill of the first group.
  useEffect(() => {
    if (selection) return;
    const first = data.skills[0];
    if (first) setSelection({ kind: "skill", name: first.name });
  }, [data.skills, selection]);

  // Load the selected item's content.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    setEditing(false);
    setLoadingBody(true);
    setBody(null);
    const url =
      selection.kind === "skill"
        ? `/api/skills/${encodeURIComponent(selection.name)}`
        : `/api/kernel/${encodeURIComponent(selection.name)}`;
    void api<SkillBody>(url)
      .then((res) => {
        if (!cancelled) setBody(res);
      })
      .catch(() => {
        if (!cancelled) setBody(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingBody(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const selectedSkill =
    selection?.kind === "skill" ? data.skills.find((s) => s.name === selection.name) : undefined;

  function startEdit(): void {
    if (!body) return;
    setDraft(stripFrontmatter(body.content));
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    if (!selection || selection.kind !== "skill" || saving) return;
    setSaving(true);
    try {
      const res = await api<SkillBody>(`/api/skills/${encodeURIComponent(selection.name)}`, {
        method: "PUT",
        body: JSON.stringify({ content: draft })
      });
      if (res) {
        setBody(res);
        setEditing(false);
        toast(`Saved ${selection.name}.`, { tone: "success" });
      }
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class={embedded ? "settings-embedded-panel catalog-view" : "view catalog-view"} id="skillsView">
      {embedded ? null : (
        <div class="view-header catalog-view-header">
          <div>
            <h1 class="view-title">Skills &amp; Kernel</h1>
            <p class="view-subtitle">
              {data.skills.length} skill(s) · {data.kernelSections.length} kernel section(s). Edit a skill
              inline; kernel sections are read-only.
            </p>
          </div>
        </div>
      )}

      <div class="catalog-shell">
        <aside class="catalog-rail">
          <div class="catalog-search">
            <span class="catalog-search-ico" dangerouslySetInnerHTML={{ __html: icon("search", 14) }} />
            <input
              class="input"
              id="skillsFilter"
              type="text"
              autocomplete="off"
              placeholder="Search skills"
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          {groups.map(({ category, skills }) => (
            <Group
              key={category.id}
              label={category.label}
              count={skills.length}
              expanded={isExpanded(category.id)}
              onToggle={() => toggle(category.id)}
            >
              {skills.map((skill) => (
                <CatalogItem
                  key={skill.name}
                  iconName={CATEGORY_ICONS[skill.category]}
                  name={skill.name}
                  sub={skill.description}
                  selected={selection?.kind === "skill" && selection.name === skill.name}
                  onSelect={() => setSelection({ kind: "skill", name: skill.name })}
                />
              ))}
            </Group>
          ))}

          {kernelMatches.length ? (
            <Group
              label="Kernel sections"
              count={kernelMatches.length}
              expanded={isExpanded(KERNEL_GROUP_ID)}
              onToggle={() => toggle(KERNEL_GROUP_ID)}
            >
              {kernelMatches.map((section) => (
                <CatalogItem
                  key={section}
                  iconName="file"
                  name={section}
                  sub="Kernel section"
                  selected={selection?.kind === "kernel" && selection.name === section}
                  onSelect={() => setSelection({ kind: "kernel", name: section })}
                />
              ))}
            </Group>
          ) : null}

          {!groups.length && !kernelMatches.length ? (
            <p class="catalog-empty">No skills match “{query}”.</p>
          ) : null}
        </aside>

        <main class="catalog-detail">
          {selection ? (
            <div class="catalog-detail-inner">
              <header class="catalog-id-head">
                <span class="catalog-id-logo">
                  <Icon
                    name={selection.kind === "kernel" ? "file" : CATEGORY_ICONS[selectedSkill?.category ?? "other"]}
                    size={26}
                  />
                </span>
                <div class="catalog-id-text">
                  <div class="catalog-id-title-row">
                    <h2 class="catalog-id-title">{selection.name}</h2>
                    <span class="catalog-badge">
                      {selection.kind === "kernel" ? "Kernel section" : "Skill"}
                    </span>
                  </div>
                  {selectedSkill?.description ? (
                    <p class="catalog-id-account">{selectedSkill.description}</p>
                  ) : null}
                </div>
                {selection.kind === "skill" ? (
                  <div class="catalog-id-actions">
                    {editing ? (
                      <>
                        <button class="btn btn-ghost" type="button" onClick={() => setEditing(false)} disabled={saving}>
                          <Icon name="x" size={14} />
                          <span>Cancel</span>
                        </button>
                        <button class="btn btn-primary" type="button" onClick={() => void saveEdit()} disabled={saving}>
                          <Icon name="check" size={14} />
                          <span>{saving ? "Saving…" : "Save"}</span>
                        </button>
                      </>
                    ) : (
                      <button class="btn" type="button" onClick={startEdit} disabled={!body || loadingBody}>
                        <Icon name="edit" size={14} />
                        <span>Edit</span>
                      </button>
                    )}
                  </div>
                ) : null}
              </header>

              <section class="catalog-panel">
                {editing ? (
                  <div class="skill-edit">
                    <textarea
                      class="input skill-edit-textarea"
                      spellcheck={false}
                      value={draft}
                      placeholder="Write the skill body in Markdown…"
                      onKeyDown={(e) => {
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const el = e.currentTarget as HTMLTextAreaElement;
                          const start = el.selectionStart;
                          const end = el.selectionEnd;
                          const next = `${draft.slice(0, start)}  ${draft.slice(end)}`;
                          setDraft(next);
                          requestAnimationFrame(() => {
                            el.selectionStart = el.selectionEnd = start + 2;
                          });
                        }
                      }}
                      onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
                    />
                    <p class="skill-edit-hint">
                      <Icon name="file" size={13} />
                      <span>
                        Editing the Markdown body. Frontmatter (name, description, category) is preserved automatically.
                      </span>
                    </p>
                  </div>
                ) : loadingBody ? (
                  <div class="catalog-panel-body skill-doc-empty">Loading…</div>
                ) : body ? (
                  <div
                    class="catalog-panel-body skill-doc message-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(stripFrontmatter(body.content)) }}
                  />
                ) : (
                  <div class="catalog-panel-body skill-doc-empty">Could not load this content.</div>
                )}
              </section>
            </div>
          ) : (
            <p class="catalog-empty">Select a skill to view it.</p>
          )}
        </main>
      </div>
    </div>
  );
}

export function SkillsPanel() {
  const [data, setData] = useState<SkillsResponse | null>(cached);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (data) return;
    let cancelled = false;
    void api<SkillsResponse>("/api/skills")
      .then((res) => {
        if (cancelled || !res) {
          if (!cancelled) setError(true);
          return;
        }
        cached = res;
        setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (error) return <p class="muted">Could not load skills.</p>;
  if (!data) return <p class="muted">Loading skills…</p>;
  return <SkillsView data={data} embedded />;
}
