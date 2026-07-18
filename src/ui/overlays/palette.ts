import { $, escapeHtml } from "@ui/shell/dom.js";
import { findTask, isViewName, ui } from "@ui/app/state.js";
import { taskIsRunning, uiLegacyStatus } from "@ui/app/task-status.js";
import { navigate } from "@ui/app/router.js";
import { setTheme } from "@ui/app/state.js";
import { executeTaskAction, getPrimaryAction } from "@ui/shared/components/task-actions.tsx";
import { bestFuzzyScore } from "./palette-fuzzy.js";
import { getRecentPaletteIds, recordPaletteRecent } from "./palette-recent.js";
import { bindDialogDismiss } from "./dialog.ts";

interface PaletteItem {
  section: string;
  id: string;
  label: string;
  meta?: string;
  perform: () => void | Promise<void>;
}

let items: PaletteItem[] = [];
let active = 0;
let query = "";

const dlg = (): HTMLDialogElement => $("#paletteDialog") as HTMLDialogElement;

function wrapPerform(item: PaletteItem): () => void | Promise<void> {
  return () => {
    recordPaletteRecent(item.id);
    return item.perform();
  };
}

function contextualTaskActions(): PaletteItem[] {
  const task = findTask(ui.taskId);
  if (!task || ui.view !== "task") return [];

  const out: PaletteItem[] = [];
  const primary = getPrimaryAction(task);
  if (primary) {
    out.push({
      section: "Task",
      id: `task-action-${primary.action}-${task.id}`,
      label: primary.label,
      meta: uiLegacyStatus(task),
      perform: () => executeTaskAction(task, primary.action)
    });
  }
  if (taskIsRunning(task) && task.runId && primary?.action !== "stop") {
    out.push({
      section: "Task",
      id: `task-action-stop-${task.id}`,
      label: "Stop",
      meta: uiLegacyStatus(task),
      perform: () => executeTaskAction(task, "stop")
    });
  }
  return out;
}

function build(): PaletteItem[] {
  const out: PaletteItem[] = [
    {
      section: "Actions",
      id: "act-new-task",
      label: "Create new task",
      meta: "N",
      perform: () => document.dispatchEvent(new CustomEvent("harness:new-task"))
    },
    {
      section: "Actions",
      id: "act-new-mem",
      label: "Capture memory",
      perform: () => document.dispatchEvent(new CustomEvent("harness:capture-memory"))
    },
    {
      section: "Actions",
      id: "act-toggle-theme",
      label: `Switch to ${ui.theme === "dark" ? "light" : "dark"} theme`,
      perform: () => {
        setTheme(ui.theme === "dark" ? "light" : "dark");
        document.dispatchEvent(new CustomEvent("harness:refresh-render"));
      }
    },
    ...(["home", "skills", "connectors", "workflows", "maintenance", "settings"] as const).map(
      (v) => ({
        section: "Navigate",
        id: `nav-${v}`,
        label: v === "home" ? "Go to home (attention)" : `Go to ${v}`,
        meta: v === "home" ? "g h" : `g ${v[0]}`,
        perform: () => {
          if (isViewName(v)) navigate(v);
        }
      })
    )
  ];

  out.push(...contextualTaskActions());

  for (const t of ui.data?.tasks ?? []) {
    out.push({
      section: "Tasks",
      id: `task-${t.id}`,
      label: t.title,
      meta: uiLegacyStatus(t),
      perform: () => navigate("task", t.id)
    });
  }
  return out.map((item) => ({ ...item, perform: wrapPerform(item) }));
}

function filtered(): PaletteItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;

  return items
    .map((item) => ({
      item,
      score: bestFuzzyScore(trimmed, [item.label, item.section, item.meta])
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .map((entry) => entry.item);
}

function groupedList(list: PaletteItem[]): Array<[string, PaletteItem[]]> {
  if (query.trim()) {
    const grouped: Record<string, PaletteItem[]> = {};
    for (const item of list) {
      const section = grouped[item.section] ?? [];
      section.push(item);
      grouped[item.section] = section;
    }
    return Object.entries(grouped);
  }

  const recentIds = new Set(getRecentPaletteIds());
  const recent = list.filter((item) => recentIds.has(item.id));
  const restGrouped: Record<string, PaletteItem[]> = {};

  for (const item of list) {
    if (recentIds.has(item.id)) continue;
    const section = restGrouped[item.section] ?? [];
    section.push(item);
    restGrouped[item.section] = section;
  }

  const sections: Array<[string, PaletteItem[]]> = [];
  if (recent.length) sections.push(["Recent", recent]);
  sections.push(...Object.entries(restGrouped));
  return sections;
}

function draw(): void {
  const d = dlg();
  const list = filtered();
  if (active >= list.length) active = Math.max(0, list.length - 1);

  const sections = groupedList(list);

  d.innerHTML = `
    <input class="palette-input" id="paletteInput" placeholder="Search tasks, memory, actions… Press ? for shortcuts" value="${escapeHtml(query)}" />
    <div class="palette-list">
      ${
        list.length === 0
          ? `<div class="palette-empty">No matches.</div>`
          : sections
              .map(
                ([section, entries]) => `
                  <div class="palette-section">${escapeHtml(section)}</div>
                  ${entries
                    .map(
                      (item) => `
                        <div class="palette-item ${item === list[active] ? "active" : ""}" data-id="${item.id}">
                          <span>${escapeHtml(item.label)}</span>
                          ${item.meta ? `<span class="meta">${escapeHtml(item.meta)}</span>` : ""}
                        </div>
                      `
                    )
                    .join("")}
                `
              )
              .join("")
      }
    </div>
  `;

  const input = $("#paletteInput") as HTMLInputElement;
  input.focus();
  input.setSelectionRange(query.length, query.length);
  input.addEventListener("input", () => {
    query = input.value;
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(filtered().length - 1, active + 1);
      draw();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = filtered()[active];
      if (choice) {
        d.close();
        Promise.resolve(choice.perform());
      }
    } else if (event.key === "Escape") {
      d.close();
    }
  });
  d.querySelectorAll<HTMLElement>(".palette-item").forEach((row) => {
    row.addEventListener("click", () => {
      const item = list.find((i) => i.id === row.dataset["id"]);
      if (!item) return;
      d.close();
      Promise.resolve(item.perform());
    });
  });
}

export function openPalette(): void {
  items = build();
  query = "";
  active = 0;
  const d = dlg();
  bindDialogDismiss(d);
  d.showModal();
  draw();
}
