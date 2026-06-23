import { useEffect, useRef, useState } from "preact/hooks";

import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";
import { canOpenWorktree } from "@ui/app/task-status.js";
import { icon } from "@ui/shell/icons.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import type { EditorOption, HarnessTask } from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

/**
 * Per-ticket "Open worktree" dropdown. Lists the desktop editors the backend
 * advertises in `/api/state` and hands the ticket's harness worktree to the chosen
 * one via POST /api/tasks/:id/open-in-editor. Disabled when the ticket has no
 * worktree; launch failures surface as a toast without leaving the page.
 */
export function WorktreeHandoffMenu({ task }: { task: HarnessTask }) {
  const editors = ui.data?.editors ?? [];
  const enabled = canOpenWorktree(task);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  async function openIn(editor: EditorOption): Promise<void> {
    setOpen(false);
    try {
      await api(`/api/tasks/${task.id}/open-in-editor`, {
        method: "POST",
        body: JSON.stringify({ editor: editor.id })
      });
      toast(`Opening worktree in ${editor.label}`);
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  return (
    <div class="worktree-handoff" ref={ref}>
      <button
        type="button"
        class="btn btn-sm btn-ghost worktree-handoff-btn"
        title={enabled ? "Open this ticket's worktree in a desktop editor" : "No worktree for this ticket yet"}
        disabled={!enabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (enabled) setOpen((value) => !value);
        }}
      >
        <Icon name="external-link" size={14} />
        <span>Open worktree</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && enabled ? (
        <div class="status-menu open worktree-handoff-menu" role="menu">
          <div class="status-menu-title">Open in editor</div>
          {editors.map((editor) => (
            <button
              key={editor.id}
              type="button"
              class="status-opt"
              role="menuitem"
              onClick={() => void openIn(editor)}
            >
              <span class="status-opt-body">
                <span class="status-opt-label">{editor.label}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
