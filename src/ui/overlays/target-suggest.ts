import { api } from "@ui/data/api.js";
import { $, escapeHtml } from "@ui/shell/dom.js";

interface Suggestion {
  label: string;
  path: string;
  insertText: string;
}

interface AtToken {
  token: string;
  start: number;
  end: number;
}

let activeInput: HTMLInputElement | HTMLTextAreaElement | null = null;
let activeIndex = 0;

function suggestBox(): HTMLElement | null {
  return $("#targetSuggest");
}

function isOpen(box: HTMLElement): boolean {
  return box.style.display !== "none";
}

function showBox(box: HTMLElement): void {
  box.style.display = "block";
}

function positionSuggestBox(box: HTMLElement, input: HTMLElement): void {
  const rect = input.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.maxWidth = `${Math.min(640, window.innerWidth - rect.left - 12)}px`;

  const preferAbove =
    input.id === "intakeInput" || input.closest(".intake-composer") !== null;
  const boxHeight = Math.min(box.offsetHeight, 240);
  const spaceBelow = window.innerHeight - rect.bottom;

  if (preferAbove || (spaceBelow < boxHeight + 12 && rect.top > spaceBelow)) {
    box.style.top = "auto";
    box.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    return;
  }

  box.style.bottom = "auto";
  box.style.top = `${rect.bottom + 6}px`;
}

function hideBox(box: HTMLElement): void {
  box.style.display = "none";
  if (box.parentElement && box.parentElement !== document.body) {
    document.body.appendChild(box);
  }
  activeInput = null;
  activeIndex = 0;
}

function suggestionButtons(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>("[data-target-insert]")];
}

function highlightActiveItem(box: HTMLElement): void {
  const buttons = suggestionButtons(box);
  buttons.forEach((button, index) => {
    const selected = index === activeIndex;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) {
      button.scrollIntoView({ block: "nearest" });
    }
  });
}

function currentAtToken(input: HTMLInputElement | HTMLTextAreaElement): AtToken | null {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(^|[\s([{])(@[^\s,;)"']*)$/);
  if (!match) return null;
  const token = match[2];
  if (!token) return null;
  return { token, start: cursor - token.length, end: cursor };
}

/**
 * For inputs with data-path-suggest: treat the entire input value as an
 * @ token. This reuses the same fuzzy search endpoint but without
 * requiring the user to type @ first.
 */
function pathSuggestToken(input: HTMLInputElement | HTMLTextAreaElement): AtToken | null {
  const value = input.value.trim();
  if (!value) return null;
  return {
    token: `@${value}`,
    start: 0,
    end: input.value.length
  };
}

function reParentIfNeeded(box: HTMLElement): void {
  if (box.parentElement !== document.body) {
    document.body.appendChild(box);
  }
}

async function updateSuggestions(input: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const box = suggestBox();
  if (!box) return;

  const isPathSuggest = input.dataset["pathSuggest"] !== undefined;
  const token = isPathSuggest
    ? pathSuggestToken(input)
    : currentAtToken(input);

  if (!token) {
    hideBox(box);
    return;
  }

  const suggestions = await api<Suggestion[]>(
    `/api/targets/complete?prefix=${encodeURIComponent(token.token)}`
  );
  if (!suggestions?.length) {
    hideBox(box);
    return;
  }

  activeInput = input;
  reParentIfNeeded(box);
  activeIndex = 0;

  if (isPathSuggest) {
    // For path-suggest, render with path as insertText (no @ prefix)
    // and use full-value replacement (start=0, end=length)
    const len = input.value.length;
    box.innerHTML = suggestions
      .map(
        (item, index) => `
          <button type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" class="${index === 0 ? "is-active" : ""}" data-target-insert="${escapeHtml(item.path)}" data-target-start="0" data-target-end="${len}">
            ${escapeHtml(item.label)}<small>${escapeHtml(item.path)}</small>
          </button>
        `
      )
      .join("");
  } else {
    box.innerHTML = suggestions
      .map(
        (item, index) => `
          <button type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" class="${index === 0 ? "is-active" : ""}" data-target-insert="${escapeHtml(item.insertText)}" data-target-start="${token.start}" data-target-end="${token.end}">
            ${escapeHtml(item.label)}<small>${escapeHtml(item.path)}</small>
          </button>
        `
      )
      .join("");
  }

  box.setAttribute("role", "listbox");
  showBox(box);
  positionSuggestBox(box, input);
  highlightActiveItem(box);
}

function applySuggestion(btn: HTMLElement): void {
  const input = activeInput ?? (document.activeElement as HTMLInputElement | HTMLTextAreaElement);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
  if (!input.isConnected) return;

  const insertText = btn.dataset["targetInsert"] ?? "";
  const start = Number(btn.dataset["targetStart"] ?? 0);
  const end = Number(btn.dataset["targetEnd"] ?? 0);

  input.value = `${input.value.slice(0, start)}${insertText}${input.value.slice(end)}`;
  input.focus();
  input.selectionStart = input.selectionEnd = start + insertText.length;

  // For path-suggest inputs, dispatch input event so Preact state updates
  if (input.dataset["pathSuggest"] !== undefined) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const box = suggestBox();
  if (box) hideBox(box);
}

/**
 * Call once at app boot. Installs global listeners for @-autocomplete on any
 * input/textarea in the document. Inputs with data-path-suggest get immediate
 * fuzzy search without needing the @ prefix.
 */
export function initTargetSuggest(): void {
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      void updateSuggestions(target);
    }
  });

  // Prevent focus transfer when clicking inside the suggestion box so the
  // active input keeps focus and blur handlers cannot destroy it before the
  // click event reaches the document listener below.
  document.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    const box = suggestBox();
    if (box && isOpen(box) && box.contains(target)) {
      event.preventDefault();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const btn = target.closest("[data-target-insert]") as HTMLElement | null;
    if (btn) {
      event.preventDefault();
      event.stopPropagation();
      applySuggestion(btn);
      return;
    }
    const box = suggestBox();
    if (box && isOpen(box) && !box.contains(target)) {
      hideBox(box);
    }
  });

  document.addEventListener("keydown", (event) => {
    const box = suggestBox();
    if (!box || !isOpen(box)) return;

    const input = activeInput;
    if (!input || document.activeElement !== input) return;

    const buttons = suggestionButtons(box);
    if (buttons.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = Math.min(buttons.length - 1, activeIndex + 1);
      highlightActiveItem(box);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      highlightActiveItem(box);
      return;
    }

    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const selected = buttons[activeIndex];
      if (selected) applySuggestion(selected);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      hideBox(box);
    }
  });
}
