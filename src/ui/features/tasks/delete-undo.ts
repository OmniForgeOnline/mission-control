import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { requestRefresh, requestRefreshRender } from "@ui/data/refresh.js";
import type { HarnessTask } from "@ui/app/types.js";

const UNDO_MS = 6000;

interface PendingDelete {
  snapshot: HarnessTask[];
  timer: number;
}

const pending = new Map<string, PendingDelete>();

function pendingKey(ids: string[]): string {
  return ids.slice().sort().join(",");
}

export function softDeleteTasks(tasks: HarnessTask[], onUpdate: () => void): void {
  if (!ui.data || tasks.length === 0) return;

  const ids = new Set(tasks.map((task) => task.id));
  const key = pendingKey([...ids]);
  const snapshot = tasks.map((task) => ({ ...task }));

  ui.data.tasks = ui.data.tasks.filter((task) => !ids.has(task.id));
  for (const id of ids) ui.selectedTaskIds.delete(id);
  onUpdate();
  requestRefreshRender();

  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = window.setTimeout(() => {
    pending.delete(key);
    void flushDelete([...ids]);
  }, UNDO_MS);

  pending.set(key, { snapshot, timer });

  const label =
    tasks.length === 1 ? `"${tasks[0]!.title}"` : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  toast(`Deleted ${label}.`, {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => undoDelete(key, onUpdate)
    }
  });
}

function undoDelete(key: string, onUpdate: () => void): void {
  const entry = pending.get(key);
  if (!entry || !ui.data) return;
  clearTimeout(entry.timer);
  pending.delete(key);

  const existingIds = new Set(ui.data.tasks.map((task) => task.id));
  for (const task of entry.snapshot) {
    if (!existingIds.has(task.id)) ui.data.tasks.push(task);
  }
  onUpdate();
  requestRefreshRender();
}

async function flushDelete(ids: string[]): Promise<void> {
  try {
    if (ids.length === 1) {
      await api(`/api/tasks/${ids[0]}`, { method: "DELETE" });
    } else {
      await api("/api/tasks/delete", { method: "POST", body: JSON.stringify({ ids }) });
    }
    requestRefresh();
  } catch (err) {
    errorToast(`Delete failed: ${(err as Error).message}`);
    requestRefresh();
  }
}