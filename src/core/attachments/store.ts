import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJsonFile, updateJsonFile } from "../infra/fs.ts";
import type { AttachmentSource, HarnessAttachment } from "../types.ts";
import {
  attachmentFilePath,
  attachmentsDir,
  attachmentsFilesDir,
  formatAttachmentReference,
  withAttachmentReferences
} from "./paths.ts";

// Re-export the pure path/formatting helpers so existing importers of the
// store keep working. Browser-reachable code (workflows/prompts.ts) imports
// these from ./paths.ts directly to stay clear of this module's node:fs
// dependency in the client bundle.
export {
  attachmentFilePath,
  attachmentsDir,
  attachmentsFilesDir,
  formatAttachmentReference,
  withAttachmentReferences
};

/** Conservative per-attachment size cap. Kept as a single constant so it can be
 * tightened without touching call sites. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Extensions we refuse to store even as inert blobs; operators who genuinely
 * need one can extend this denylist later. Kept small and OS-executable only. */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "msi",
  "app"
]);

const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_FILENAME = "attachment";

function attachmentsRegistryPath(root: string): string {
  return path.join(attachmentsDir(root), "index.json");
}

type AttachmentRegistry = Record<string, HarnessAttachment>;

async function readRegistry(root: string): Promise<AttachmentRegistry> {
  return readJsonFile<AttachmentRegistry>(attachmentsRegistryPath(root), {});
}

/** True only for uuid-shaped ids. Used to reject traversal-shaped ids at the
 * download boundary before they reach the filesystem. */
export function isAttachmentId(value: string): boolean {
  return ATTACHMENT_ID_PATTERN.test(value);
}

/** Strip directory components and header/control characters from a user-supplied
 * filename. Storage is id-keyed, so this only affects display + Content-Disposition. */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw ?? "").trim();
  if (!base || base === "." || base === "..") return FALLBACK_FILENAME;
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || FALLBACK_FILENAME;
}

const MIME_TOKEN_PATTERN = /^[a-z0-9!#$&^_\-.+]+\/[a-z0-9!#$&^_\-.+]+$/i;

function sanitizeMimeType(raw: string | undefined): string {
  const candidate = (raw ?? "").trim().toLowerCase();
  if (!candidate) return "application/octet-stream";
  // Strict RFC-token shape: allows the single `type/subtype` slash but no
  // whitespace, quotes, or brackets, so it cannot inject into Content-Type or
  // a quoted Content-Disposition header.
  return MIME_TOKEN_PATTERN.test(candidate) ? candidate : "application/octet-stream";
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** Validate filename + size against policy. Throws with an actionable message. */
export function assertAttachmentAllowed(filename: string, byteLength: number): void {
  if (path.basename(String(filename ?? "")).trim() === "") {
    throw new Error("Attachment filename is required.");
  }
  const sanitized = sanitizeFilename(filename);
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error("Attachment is empty.");
  }
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is ${byteLength} bytes; limit is ${MAX_ATTACHMENT_BYTES} bytes.`
    );
  }
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(extensionOf(sanitized))) {
    throw new Error(`Attachment type .${extensionOf(sanitized)} is not allowed.`);
  }
}

interface PersistInput {
  filename: string;
  mimeType?: string;
  bytes: Buffer;
  source: AttachmentSource;
  sourceUrl?: string;
  sourceKey?: string;
}

async function persistAttachment(root: string, input: PersistInput): Promise<HarnessAttachment> {
  assertAttachmentAllowed(input.filename, input.bytes.byteLength);
  const id = crypto.randomUUID();
  const record: HarnessAttachment = {
    id,
    filename: sanitizeFilename(input.filename),
    mimeType: sanitizeMimeType(input.mimeType),
    size: input.bytes.byteLength,
    source: input.source,
    createdAt: new Date().toISOString(),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sourceKey ? { sourceKey: input.sourceKey } : {})
  };
  // Blob first, registry second: a failed registry write may orphan a blob, but
  // never leaves a registry reference pointing at a missing file.
  await ensureDir(attachmentsFilesDir(root));
  await writeFile(path.join(attachmentsFilesDir(root), id), input.bytes);
  await updateJsonFile<AttachmentRegistry>(
    attachmentsRegistryPath(root),
    {},
    (registry) => ({ ...registry, [id]: record })
  );
  return record;
}

/** Persist an operator-uploaded attachment (intake or workflow step reply). */
export async function saveUploadedAttachment(
  root: string,
  input: {
    filename: string;
    mimeType?: string;
    data: Buffer;
    source: "intake" | "workflow";
  }
): Promise<HarnessAttachment> {
  return persistAttachment(root, {
    filename: input.filename,
    bytes: input.data,
    source: input.source,
    ...(input.mimeType ? { mimeType: input.mimeType } : {})
  });
}

/** Persist an imported remote attachment (ClickUp). Callers should check
 * `findAttachmentBySourceKey` first to avoid re-downloading on dedup. */
export async function saveRemoteAttachment(
  root: string,
  input: {
    filename: string;
    mimeType?: string;
    bytes: Buffer;
    sourceUrl: string;
    sourceKey: string;
  }
): Promise<HarnessAttachment> {
  return persistAttachment(root, {
    filename: input.filename,
    bytes: input.bytes,
    source: "clickup",
    sourceUrl: input.sourceUrl,
    sourceKey: input.sourceKey,
    ...(input.mimeType ? { mimeType: input.mimeType } : {})
  });
}

export async function getAttachment(root: string, id: string): Promise<HarnessAttachment | undefined> {
  if (!isAttachmentId(id)) return undefined;
  const registry = await readRegistry(root);
  return registry[id];
}

/** Return the existing record for a dedup key, if any. */
export async function findAttachmentBySourceKey(
  root: string,
  sourceKey: string
): Promise<HarnessAttachment | undefined> {
  const registry = await readRegistry(root);
  return Object.values(registry).find((attachment) => attachment.sourceKey === sourceKey);
}

/** Resolve attachment ids to metadata, throwing if any id is unknown so failed
 * or replayed uploads cannot leave dangling references on tasks/messages. */
export async function requireAttachments(
  root: string,
  ids: readonly string[]
): Promise<HarnessAttachment[]> {
  if (ids.length === 0) return [];
  const registry = await readRegistry(root);
  const resolved: HarnessAttachment[] = [];
  for (const id of ids) {
    // Guard the lookup: a plain object indexed with a prototype key like
    // "__proto__" or "constructor" resolves to an inherited member and would
    // bypass the unknown-attachment check. Reject anything that is not a uuid
    // (which can never collide with a prototype key) and read only own
    // properties, so the lookup cannot surface an inherited value.
    if (!isAttachmentId(id)) {
      throw new Error(`Unknown attachment: ${id}`);
    }
    const record = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!record) {
      throw new Error(`Unknown attachment: ${id}`);
    }
    resolved.push(record);
  }
  return resolved;
}

/** Absolute path to the stored blob, or undefined if the blob is missing. */
export async function attachmentBlobPath(root: string, id: string): Promise<string | undefined> {
  if (!isAttachmentId(id)) return undefined;
  if (!(await getAttachment(root, id))) return undefined;
  return attachmentFilePath(root, id);
}
