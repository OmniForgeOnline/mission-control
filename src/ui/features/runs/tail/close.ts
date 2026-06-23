import { allTails, getTail, removeTail } from "./state.ts";

export function close(runId?: string): void {
  if (!runId) {
    for (const inst of allTails()) close(inst.runId);
    return;
  }

  const inst = getTail(runId);
  if (!inst) return;

  if (inst.timer != null) {
    clearInterval(inst.timer);
    inst.timer = null;
  }
  document
    .querySelectorAll<HTMLElement>(`[data-tail="${runId}"]`)
    .forEach((btn) => btn.classList.remove("is-active"));
  if (inst.host) inst.host.innerHTML = "";
  removeTail(runId);
}