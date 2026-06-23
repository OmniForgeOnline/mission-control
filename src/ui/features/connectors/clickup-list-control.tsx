import type { ConnectorConnection, ConnectorResourceOption } from "../../../core/types.ts";
import type { ProjectSummary } from "@ui/app/types.js";
import { useMemo, useState } from "preact/hooks";
import { icon } from "@ui/shell/icons.js";

export interface ClickUpListControlProps {
  connection: ConnectorConnection;
  resources: ConnectorResourceOption[];
  projects: ProjectSummary[];
  onChange: (
    connectionId: string,
    listIds: string[],
    resources: ConnectorResourceOption[],
    projectBindings: Record<string, string>
  ) => void;
}

interface ListRow {
  id: string;
  name: string;
  context: string;
  resource: ConnectorResourceOption;
}

function Glyph({ name, size = 14 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

/** Split a "team / space / folder / list" label into a list name + its context path. */
function splitLabel(label: string): { name: string; context: string } {
  const parts = label.split(" / ").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { name: label, context: "" };
  const name = parts[parts.length - 1] ?? label;
  const context = parts.slice(0, -1).join(" / ");
  return { name, context };
}

export function ClickUpListControl({ connection, resources, projects, onChange }: ClickUpListControlProps) {
  const [query, setQuery] = useState("");

  const selected = new Set([
    ...(connection.config.clickup?.subscribedListIds ?? []),
    ...(connection.config.clickup?.listId ? [connection.config.clickup.listId] : [])
  ]);
  const bindings = connection.config.clickup?.listProjectBindings ?? {};

  const rows = useMemo<ListRow[]>(
    () =>
      resources.map((resource) => {
        const { name, context } = splitLabel(resource.label);
        return { id: resource.id, name, context, resource };
      }),
    [resources]
  );

  const filtered = useMemo<ListRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.context} ${row.name}`.toLowerCase().includes(q));
  }, [rows, query]);

  const subscribedCount = rows.filter((row) => selected.has(row.id)).length;

  function emit(nextSelected: Set<string>, nextBindings: Record<string, string>): void {
    const nextIds = resources.map((entry) => entry.id).filter((id) => nextSelected.has(id));
    const nextResources = resources.filter((entry) => nextSelected.has(entry.id));
    const prunedBindings = Object.fromEntries(
      Object.entries(nextBindings).filter(([listId, projectId]) => nextSelected.has(listId) && projectId)
    );
    onChange(connection.id, nextIds, nextResources, prunedBindings);
  }

  function toggle(id: string, checked: boolean): void {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    emit(next, bindings);
  }

  function bind(id: string, projectId: string): void {
    emit(selected, { ...bindings, [id]: projectId });
  }

  if (resources.length === 0) {
    return (
      <div class="connector-map-empty">
        <Glyph name="list-checks" size={22} />
        <p>No ClickUp lists synced yet.</p>
        <span>Use “Sync lists” above to pull your workspace lists, then subscribe the ones to poll.</span>
      </div>
    );
  }

  return (
    <div class="connector-map">
      <div class="connector-map-toolbar">
        <div class="connector-map-search">
          <span class="connector-map-search-ico" dangerouslySetInnerHTML={{ __html: icon("search", 14) }} />
          <input
            class="input"
            type="text"
            placeholder="Filter lists…"
            autocomplete="off"
            value={query}
            onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <span class="connector-map-count">
          <b>{subscribedCount}</b> of {rows.length} {rows.length === 1 ? "list" : "lists"} subscribed
        </span>
      </div>

      <div class="connector-map-scroll">
        <table class="connector-map-table" data-provider="clickup" data-connection-id={connection.id}>
          <thead>
            <tr>
              <th class="cm-col-sub" scope="col">
                <span class="sr-only">Subscribe</span>
              </th>
              <th scope="col">List</th>
              <th class="cm-col-proj" scope="col">
                Project
              </th>
              <th class="cm-col-poll" scope="col">
                Polling
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const checked = selected.has(row.id);
              const boundProject = bindings[row.id] ?? "";
              return (
                <tr key={row.id} class={checked ? "" : "is-muted"}>
                  <td class="cm-col-sub">
                    <input
                      class="connector-map-check"
                      type="checkbox"
                      checked={checked}
                      aria-label={`Subscribe to ${row.name}`}
                      onChange={(event) => toggle(row.id, (event.currentTarget as HTMLInputElement).checked)}
                    />
                  </td>
                  <td>
                    <div class="connector-map-list">
                      <span class="connector-map-list-name">{row.name}</span>
                      {row.context ? <span class="connector-map-list-context">{row.context}</span> : null}
                    </div>
                  </td>
                  <td class="cm-col-proj">
                    <select
                      class={`select connector-map-project${boundProject ? "" : " is-unset"}`}
                      value={boundProject}
                      disabled={!checked}
                      aria-label={`Project for ${row.name}`}
                      onChange={(event) => bind(row.id, (event.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">No project</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td class="cm-col-poll">
                    {checked ? (
                      <span class="connector-poll is-on">
                        <span class="connector-poll-dot" />
                        Polling
                      </span>
                    ) : (
                      <span class="connector-poll is-off">
                        <span class="connector-poll-dot" />
                        Not polled
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 ? (
              <tr class="connector-map-noresult">
                <td colSpan={4}>No lists match “{query}”.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div class="connector-map-foot">
        <span dangerouslySetInnerHTML={{ __html: icon("activity", 13) }} />
        <span>
          Subscribed lists are polled for tasks and comments containing <code>@omc</code>. Bound projects
          receive any imported tasks.
        </span>
      </div>
    </div>
  );
}
