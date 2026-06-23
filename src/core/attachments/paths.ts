import type { HarnessAttachment } from "../types.ts";

/**
 * Pure attachment path + reference formatting.
 *
 * This module intentionally depends only on types, never on Node built-ins.
 * Browser-reachable code imports these helpers, so path formatting uses a tiny
 * POSIX-style join that matches harness runtime paths.
 */

function joinPath(...parts: string[]): string {
  const [first = "", ...rest] = parts;
  const prefix = first.startsWith("/") ? "/" : "";
  const segments = [first, ...rest]
    .flatMap((part) => part.split("/"))
    .filter(Boolean);
  return `${prefix}${segments.join("/")}`;
}

/** Root directory for all attachment state (registry + blobs). */
export function attachmentsDir(root: string): string {
  return joinPath(root, "data", "state", "attachments");
}

/** Directory holding id-keyed attachment blobs. */
export function attachmentsFilesDir(root: string): string {
  return joinPath(attachmentsDir(root), "files");
}

/** Deterministic absolute path to the stored blob for an attachment id. Does
 * not verify the blob exists; callers needing that guarantee should use
 * `attachmentBlobPath` in `store.ts`. */
export function attachmentFilePath(root: string, id: string): string {
  return joinPath(attachmentsFilesDir(root), id);
}

/** Format a stored attachment as an agent-readable reference: the absolute blob
 * path the agent can read, plus filename, size, and mime so the id-keyed,
 * extension-less blob can be interpreted. */
export function formatAttachmentReference(root: string, attachment: HarnessAttachment): string {
  return `${attachmentFilePath(root, attachment.id)} (filename "${attachment.filename}", ${attachment.size} bytes, ${attachment.mimeType})`;
}

/** Flatten attachment lists in order, dropping any later entry whose id was
 * already seen. Used to surface task-level attachments alongside those on a
 * specific operator message without emitting duplicate references. */
export function mergeAttachments(
  ...lists: Array<readonly HarnessAttachment[] | undefined>
): HarnessAttachment[] {
  const seen = new Set<string>();
  const merged: HarnessAttachment[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const attachment of list) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      merged.push(attachment);
    }
  }
  return merged;
}

/** Append an agent-readable attachment reference block to `body` when there are
 * attachments, otherwise return `body` unchanged. Shared by the live-turn
 * handoff and the conversation/follow-up prompt builders so both paths surface
 * the same references to the agent. */
export function withAttachmentReferences(
  body: string,
  root: string,
  attachments?: readonly HarnessAttachment[]
): string {
  if (!attachments?.length) return body;
  const references = attachments
    .map((attachment) => `- ${formatAttachmentReference(root, attachment)}`)
    .join("\n");
  return `${body}\n\nAttachments:\n${references}`;
}
