import { api } from "@ui/data/api.js";
import { toast } from "@ui/overlays/toast.js";
import type { ProjectSummary } from "@ui/app/types.js";

interface PickFolderResult {
  path?: string;
  canceled?: boolean;
}

/**
 * Open the native OS folder picker (server-side), then register the chosen
 * folder as a project. The project name is derived from the folder basename by
 * the server. A cancel is a silent no-op.
 */
export async function addProjectViaPicker(): Promise<void> {
  let pick: PickFolderResult | null;
  try {
    pick = await api<PickFolderResult>("/api/projects/pick-folder", { method: "POST" });
  } catch (err) {
    toast(err instanceof Error ? err.message : "Could not open the folder picker.", { tone: "error" });
    return;
  }

  if (!pick || pick.canceled || !pick.path) return;

  try {
    const project = await api<ProjectSummary>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ repoPath: pick.path })
    });
    if (!project) {
      toast("Failed to add project.", { tone: "error" });
      return;
    }
    toast(`Project "${project.name}" added.`, { tone: "success" });
    document.dispatchEvent(new CustomEvent("harness:refresh"));
  } catch (err) {
    toast(err instanceof Error ? err.message : "Failed to add project.", { tone: "error" });
  }
}
