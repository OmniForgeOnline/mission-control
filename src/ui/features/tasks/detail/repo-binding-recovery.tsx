import { useMemo, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { workflowForTask } from "@ui/app/state.js";
import { requestRefresh } from "@ui/data/refresh.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { icon } from "@ui/shell/icons.js";
import { isRepoBindingBlockedReason, taskNeedsRepoBinding } from "@ui/app/repo-binding.js";
import type { HarnessTask } from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function RepoBindingRecovery({ task }: { task: HarnessTask }) {
  const workflow = workflowForTask(task);
  const visible = useMemo(() => {
    if (!workflow) return false;
    return taskNeedsRepoBinding(task, workflow) || isRepoBindingBlockedReason(task.blockedReason ?? "");
  }, [task, workflow]);

  const suggested = task.targets[0]?.raw ?? "";
  const [repoPath, setRepoPath] = useState(suggested);
  const [busy, setBusy] = useState(false);

  if (!visible) return null;

  async function handleBind(): Promise<void> {
    const path = repoPath.trim();
    if (!path) {
      errorToast("Enter a repository path (for example @/path/to/repo).");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ task: HarnessTask; suggestedPath?: string }>(
        `/api/tasks/${task.id}/bind-repo`,
        { method: "POST", body: JSON.stringify({ path }) }
      );
      if (result && !repoPath.trim() && result.suggestedPath) {
        setRepoPath(`@${result.suggestedPath}`);
      }
      toast("Repository bound. Resume the task when ready.", { tone: "success" });
      requestRefresh();
    } catch (err) {
      errorToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="wf-repo-binding">
      <div class="wf-sec-title">Repository binding</div>
      <p class="wf-desc muted">
        This git workflow needs a repository target before it can commit, push, and open a merge
        request. Bind the destination repo below (use an <code>@/path</code> target).
      </p>
      <div class="wf-step-actions">
        <input
          class="input"
          type="text"
          value={repoPath}
          placeholder="@/path/to/repository"
          onInput={(e) => setRepoPath((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          class="btn btn-sm btn-primary"
          type="button"
          disabled={busy}
          onClick={() => void handleBind()}
        >
          <Icon name="link" size={12} />
          <span>{busy ? "Binding…" : "Bind repository"}</span>
        </button>
      </div>
    </section>
  );
}