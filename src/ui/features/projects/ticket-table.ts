import { uiLegacyStatus } from "@ui/app/task-status.js";
import type { HarnessTask } from "@ui/app/types.js";

export type TicketSort = "updated-desc" | "updated-asc";

export interface TicketTableFilter {
  name: string;
  status: string;
  sort: TicketSort;
}

export const DEFAULT_TICKET_FILTER: TicketTableFilter = {
  name: "",
  status: "all",
  sort: "updated-desc"
};

/** Distinct legacy statuses present across the given tickets, sorted for stable dropdowns. */
export function projectTicketStatuses(tasks: HarnessTask[]): string[] {
  const statuses = new Set<string>();
  for (const task of tasks) statuses.add(uiLegacyStatus(task));
  return [...statuses].sort();
}

/** Applies the name/status filters then sorts by updated time in the requested direction. */
export function filterProjectTickets(tasks: HarnessTask[], filter: TicketTableFilter): HarnessTask[] {
  const name = filter.name.trim().toLowerCase();
  const matched = tasks.filter((task) => {
    if (filter.status !== "all" && uiLegacyStatus(task) !== filter.status) return false;
    if (name && !task.title.toLowerCase().includes(name)) return false;
    return true;
  });
  const direction = filter.sort === "updated-asc" ? 1 : -1;
  return matched.sort((a, b) => (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) * direction);
}
