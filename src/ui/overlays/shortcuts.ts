import { $, escapeHtml } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";

interface ShortcutEntry {
  keys: string;
  description: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  { keys: "⌘K / Ctrl+K", description: "Open command palette" },
  { keys: "?", description: "Show keyboard shortcuts" },
  { keys: "g h", description: "Go to home" },
  { keys: "g t", description: "Go to tasks" },
  { keys: "g m", description: "Go to memory" },
  { keys: "g r", description: "Go to runs" },
  { keys: "g s", description: "Go to skills" },
  { keys: "g q", description: "Go to quality" },
  { keys: "g a", description: "Go to autonomy" },
  { keys: "g c", description: "Go to connectors" },
  { keys: "n", description: "Create new task (home intake)" },
  { keys: "Escape", description: "Dismiss the topmost overlay" },
  { keys: "↑ / ↓", description: "Navigate palette results" },
  { keys: "Enter", description: "Run selected palette item" }
];

function dialog(): HTMLDialogElement {
  return $("#shortcutsDialog") as HTMLDialogElement;
}

function render(): string {
  const rows = SHORTCUTS.map(
    (entry) => `
      <div class="shortcuts-row">
        <kbd class="shortcuts-keys">${escapeHtml(entry.keys)}</kbd>
        <span class="shortcuts-desc">${escapeHtml(entry.description)}</span>
      </div>
    `
  ).join("");

  return `
    <div class="shortcuts-panel">
      <div class="shortcuts-head">
        <div>
          <h2>Keyboard shortcuts</h2>
          <p class="muted">Power-user affordances for the operator console.</p>
        </div>
        <button class="btn btn-ghost btn-icon" type="button" id="closeShortcuts">${icon("x", 14)}</button>
      </div>
      <div class="shortcuts-body">
        ${rows}
      </div>
    </div>
  `;
}

function bind(): void {
  const dlg = dialog();
  $("#closeShortcuts")?.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (event) => {
    if (event.target === dlg) dlg.close();
  });
}

export function openShortcuts(): void {
  const dlg = dialog();
  dlg.innerHTML = render();
  bind();
  if (!dlg.open) dlg.showModal();
}