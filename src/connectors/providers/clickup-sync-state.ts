import path from "node:path";

import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { listConnections } from "../store.ts";

export interface ClickUpSyncedTask {
  clickUpTaskId: string;
  harnessTaskId: string;
  listId: string;
  taskUrl?: string;
  lastSeenUpdatedAt?: string;
  lastProcessedCommentAt?: string;
  /** @deprecated Legacy dedup marker; read once during migration to seed pickedUpCommentPosted, never written. */
  lastOutboundFingerprint?: string;
  pickedUpCommentPosted?: boolean;
  completedCommentPosted?: boolean;
  lastPostedStatus?: string;
  lastRejectedStatus?: string;
  triggerSource: "description" | "comment";
}

export interface ClickUpSyncState {
  listCursors: Record<string, string>;
  tasks: Record<string, ClickUpSyncedTask>;
}

function statePath(root: string): string {
  return path.join(root, "data", "state", "clickup-sync.json");
}

export async function getClickUpSyncState(root: string): Promise<ClickUpSyncState> {
  return readJsonFile<ClickUpSyncState>(statePath(root), { listCursors: {}, tasks: {} });
}

export async function updateClickUpSyncState(
  root: string,
  updater: (state: ClickUpSyncState) => ClickUpSyncState
): Promise<ClickUpSyncState> {
  const updated = updater(await getClickUpSyncState(root));
  await writeJsonFile(statePath(root), updated);
  return updated;
}

export async function listSubscribedClickUpListIds(root: string): Promise<string[]> {
  const connection = (await listConnections(root)).find(
    (candidate) => candidate.providerId === "clickup" && candidate.status === "connected"
  );
  const clickup = connection?.config.clickup;
  const ids = [...(clickup?.subscribedListIds ?? []), ...(clickup?.listId ? [clickup.listId] : [])];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export async function getClickUpListProjectBinding(root: string, listId: string): Promise<string | undefined> {
  const connection = (await listConnections(root)).find(
    (candidate) => candidate.providerId === "clickup" && candidate.status === "connected"
  );
  const projectId = connection?.config.clickup?.listProjectBindings?.[listId]?.trim();
  return projectId || undefined;
}
