import { icon } from "@ui/shell/icons.js";

export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector(selector) as T | null;

/** Disable a button during an async action; show spinner and restore on settle. */
export async function withPending(
  button: HTMLButtonElement | null,
  fn: () => Promise<void>
): Promise<void> {
  if (!button || button.disabled) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `${icon("loader", 14, "icon icon-spin")}<span>Working…</span>`;

  try {
    await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.innerHTML = originalHtml;
  }
}

/** Minimal keyboard-event shape the composer submit handler needs. */
interface EnterSubmitArg {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  preventDefault: () => void;
}

/**
 * Returns an onKeyDown handler for chat-style composers: plain Enter submits,
 * Shift+Enter inserts a newline. Ignores Enter during IME composition so CJK
 * input is not broken. Other keys pass through untouched.
 */
export function onEnterSubmit(submit: () => void): (event: EnterSubmitArg) => void {
  return (event: EnterSubmitArg): void => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}