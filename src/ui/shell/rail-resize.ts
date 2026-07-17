import { icon } from "@ui/shell/icons.js";

/** Side-rail width bounds (px). Operator-tunable defaults; see task plan. */
export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 480;
export const RAIL_WIDTH_DEFAULT = 224;
export const RAIL_WIDTH_KEY = "harness:rail:width";
export const RAIL_COLLAPSED_KEY = "harness:rail:collapsed";
const RAIL_WIDTH_VAR = "--rail-w";

/** Clamp an arbitrary width to the allowed rail bounds, rounding to whole px. */
export function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_WIDTH_DEFAULT;
  return Math.round(Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, px)));
}

function readStoredRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY);
    if (raw === null) return RAIL_WIDTH_DEFAULT;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clampRailWidth(parsed) : RAIL_WIDTH_DEFAULT;
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

function readStoredRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function currentRailWidth(): number {
  const inline = document.documentElement.style.getPropertyValue(RAIL_WIDTH_VAR);
  const parsed = Number.parseFloat(inline);
  return Number.isFinite(parsed) ? parsed : readStoredRailWidth();
}

/** Apply a width to the live CSS variable and persist the clamped value. */
function applyRailWidth(px: number, handle?: HTMLElement | null): void {
  const width = clampRailWidth(px);
  document.documentElement.style.setProperty(RAIL_WIDTH_VAR, `${width}px`);
  if (handle) handle.setAttribute("aria-valuenow", String(width));
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // Persistence is best-effort; ignore storage failures (private mode, quota).
  }
}

function syncCollapseControl(shell: HTMLElement, button: HTMLButtonElement): void {
  const collapsed = shell.classList.contains("collapsed");
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  button.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  button.innerHTML = icon(collapsed ? "chevron-right" : "chevron-left", 14);
}

/** Toggle the icon-only rail and persist the choice. */
export function setRailCollapsed(collapsed: boolean): void {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return;
  shell.classList.toggle("collapsed", collapsed);
  const button = shell.querySelector<HTMLButtonElement>(".rail-collapse");
  if (button) syncCollapseControl(shell, button);
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * Restore the persisted rail width and wire the drag handle + collapse chevron.
 * Idempotent: safe to call once on bootstrap. Controls live as direct children of
 * `.app-shell` (not inside `#appRail`), so they survive the rail's re-renders.
 */
export function setupRailResize(): void {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return;

  // Restore persisted width before first interaction (already applied pre-paint
  // by the early call below, but keep idempotent).
  applyRailWidth(readStoredRailWidth());
  shell.classList.toggle("collapsed", readStoredRailCollapsed());

  if (!shell.querySelector(".rail-collapse")) {
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "rail-collapse";
    syncCollapseControl(shell, collapse);
    collapse.addEventListener("click", () => {
      setRailCollapsed(!shell.classList.contains("collapsed"));
    });
    shell.appendChild(collapse);
  }

  if (shell.querySelector(".rail-resize-handle")) return;

  const handle = document.createElement("div");
  handle.className = "rail-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize sidebar");
  handle.setAttribute("aria-valuemin", String(RAIL_WIDTH_MIN));
  handle.setAttribute("aria-valuemax", String(RAIL_WIDTH_MAX));
  handle.setAttribute("aria-valuenow", String(currentRailWidth()));
  handle.tabIndex = 0;
  shell.appendChild(handle);

  const onMove = (event: PointerEvent): void => {
    // Rail starts at viewport left edge, so clientX is the desired rail width.
    applyRailWidth(event.clientX, handle);
  };
  const endDrag = (event: PointerEvent): void => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer may already be released.
    }
    document.body.classList.remove("rail-resizing");
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Don't fight the collapse control if the operator clicks near the edge.
    if ((event.target as HTMLElement).closest(".rail-collapse")) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("rail-resizing");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  });

  handle.addEventListener("dblclick", () => {
    applyRailWidth(RAIL_WIDTH_DEFAULT, handle);
  });

  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyRailWidth(currentRailWidth() - step, handle);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyRailWidth(currentRailWidth() + step, handle);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyRailWidth(RAIL_WIDTH_DEFAULT, handle);
    }
  });
}

/** Apply persisted width + collapsed state before first paint to avoid flash. */
export function restoreRailWidthEarly(): void {
  document.documentElement.style.setProperty(RAIL_WIDTH_VAR, `${readStoredRailWidth()}px`);
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (shell && readStoredRailCollapsed()) {
    shell.classList.add("collapsed");
  }
}
