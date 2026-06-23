import { api } from "@ui/data/api.js";
import type { HarnessAttachment } from "@ui/app/types.js";

/** Read a File as clean base64 (without the `data:...;base64,` prefix). */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const text = typeof result === "string" ? result : "";
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Upload a single file and return the persisted attachment metadata. */
export async function uploadAttachment(
  file: File,
  source: "intake" | "workflow"
): Promise<HarnessAttachment> {
  const data = await readFileAsBase64(file);
  const attachment = await api<HarnessAttachment>("/api/attachments", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      ...(file.type ? { mimeType: file.type } : {}),
      source,
      data
    })
  });
  if (!attachment) {
    throw new Error("Attachment upload returned no response.");
  }
  return attachment;
}

/**
 * Run `upload` over each file independently, keeping every success even when a
 * sibling throws. Returns the landed results plus the names of files that did
 * not, so the caller can commit partial progress and surface the failures
 * instead of discarding uploads that already landed.
 */
export async function collectUploads<T>(
  files: Iterable<File>,
  upload: (file: File) => Promise<T>
): Promise<{ uploaded: T[]; failed: string[] }> {
  const uploaded: T[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      uploaded.push(await upload(file));
    } catch {
      failed.push(file.name);
    }
  }
  return { uploaded, failed };
}

/**
 * Append freshly uploaded attachments to the latest parent list. Pure on
 * purpose: the picker applies it as a functional update so a value captured
 * when a selection started can never clobber a removal that landed mid-upload.
 */
export function appendAttachments(
  current: HarnessAttachment[],
  uploaded: HarnessAttachment[]
): HarnessAttachment[] {
  return [...current, ...uploaded];
}

/** Remove a single attachment by id from the latest parent list. */
export function removeAttachment(
  current: HarnessAttachment[],
  id: string
): HarnessAttachment[] {
  return current.filter((attachment) => attachment.id !== id);
}

/** Download URL for a stored attachment (serves the blob inline-free). */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
