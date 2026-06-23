import { $, escapeHtml } from "@ui/shell/dom.js";

interface ToastOptions {
  tone?: "info" | "error" | "success";
  duration?: number;
  persistent?: boolean;
  action?: { label: string; onClick: () => void };
}

/** Error toast that stays visible until manually dismissed. */
export function errorToast(message: string): void {
  toast(message, { tone: "error", duration: 0, persistent: true });
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const stack = $("#toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  const isError = opts.tone === "error";
  el.className = `toast${isError ? " toast-error" : ""}`;
  el.dataset["tone"] = opts.tone ?? "info";
  if (opts.persistent || isError && opts.duration === 0) {
    el.dataset["persistent"] = "true";
  }
  el.innerHTML = `<span class="label">${escapeHtml(message)}</span>`;
  if (opts.action) {
    const btn = document.createElement("button");
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      opts.action!.onClick();
      el.remove();
    });
    el.appendChild(btn);
  }
  const close = document.createElement("button");
  close.setAttribute("aria-label", "dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => el.remove());
  el.appendChild(close);
  stack.appendChild(el);
  const duration = opts.duration ?? 3500;
  if (duration > 0) {
    setTimeout(() => el.remove(), duration);
  }
}
