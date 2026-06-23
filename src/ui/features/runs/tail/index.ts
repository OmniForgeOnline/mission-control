import { close } from "./close.ts";
import { poll } from "./poll.ts";
import { renderInstance } from "./render.ts";
import { getOrCreateTail, getTail } from "./state.ts";

export function bindTails(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>("[data-tail]").forEach((btn) => {
    if (btn.dataset["bound"]) return;
    btn.dataset["bound"] = "true";
    const id = btn.dataset["tail"]!;
    const slot = scope.querySelector<HTMLElement>(`[data-tail-host="${id}"]`);
    const active = getTail(id);
    btn.classList.toggle("is-active", Boolean(active?.host && slot?.querySelector("[data-tail-panel]")));
    btn.addEventListener("click", () => toggle(id, btn.dataset["title"] ?? "", slot));
    if (active?.host === slot && slot?.querySelector("[data-tail-panel]")) {
      renderInstance(active);
    }
  });
}

function toggle(id: string, label: string, slot: HTMLElement | null): void {
  const existing = getTail(id);
  if (existing?.host === slot && slot?.querySelector("[data-tail-panel]")) {
    close(id);
    return;
  }
  open(id, label, slot);
}

/** Start or resume polling and render into `slot` (idempotent per run id). */
export function openTail(id: string, label: string, slot: HTMLElement | null): void {
  const inst = getOrCreateTail(id, label, slot);
  if (inst.timer == null) {
    inst.offset = 0;
    inst.buffer = "";
    inst.events.length = 0;
    inst.renderedRows = 0;
    inst.status = "active";
    inst.errorMessage = null;
    inst.pollFailures = 0;
    inst.expanded.clear();
    inst.stick = true;
    void poll(id);
    inst.timer = window.setInterval(() => void poll(id), 750);
  }
  document
    .querySelectorAll<HTMLElement>(`[data-tail="${id}"]`)
    .forEach((btn) => btn.classList.add("is-active"));
  renderInstance(inst);
}

function open(id: string, label: string, slot: HTMLElement | null): void {
  openTail(id, label, slot);
}