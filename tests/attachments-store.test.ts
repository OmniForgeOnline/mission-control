import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  assertAttachmentAllowed,
  attachmentBlobPath,
  findAttachmentBySourceKey,
  formatAttachmentReference,
  isAttachmentId,
  requireAttachments,
  saveRemoteAttachment,
  saveUploadedAttachment,
  sanitizeFilename,
  attachmentsFilesDir,
  withAttachmentReferences
} from "../src/core/attachments/store.ts";
import type { HarnessAttachment } from "../src/core/types.ts";

function stubAttachment(overrides: Partial<HarnessAttachment> = {}): HarnessAttachment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    filename: "spec.pdf",
    mimeType: "application/pdf",
    size: 2048,
    source: "workflow",
    createdAt: "2026-06-19T00:00:00.000Z",
    ...overrides
  };
}

describe("attachment store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-attachments-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("sanitizeFilename", () => {
    it("strips directory components so traversal cannot reach storage", () => {
      expect(sanitizeFilename("../../../etc/passwd")).toBe("passwd");
      expect(sanitizeFilename("nested/path/report.pdf")).toBe("report.pdf");
    });

    it("removes control and path-breaking characters but keeps the name", () => {
      expect(sanitizeFilename('a:b"c?d*.pdf')).toBe("a_b_c_d_.pdf");
    });

    it("falls back when there is nothing usable", () => {
      expect(sanitizeFilename("")).toBe("attachment");
      expect(sanitizeFilename("   ")).toBe("attachment");
      expect(sanitizeFilename(".")).toBe("attachment");
    });
  });

  describe("isAttachmentId", () => {
    it("accepts uuid-shaped ids and rejects traversal", () => {
      expect(isAttachmentId("11111111-1111-4111-8111-111111111111")).toBe(true);
      expect(isAttachmentId("../../etc/passwd")).toBe(false);
      expect(isAttachmentId("")).toBe(false);
    });
  });

  describe("assertAttachmentAllowed", () => {
    it("rejects empty payloads, oversize payloads, and blocked extensions", () => {
      expect(() => assertAttachmentAllowed("report.pdf", 0)).toThrow("empty");
      expect(() => assertAttachmentAllowed("report.pdf", MAX_ATTACHMENT_BYTES + 1)).toThrow("limit");
      expect(() => assertAttachmentAllowed("payload.exe", 4)).toThrow("not allowed");
    });

    it("accepts a normal file within the limit", () => {
      expect(() => assertAttachmentAllowed("report.pdf", 512)).not.toThrow();
    });
  });

  describe("saveUploadedAttachment", () => {
    it("writes the blob and registers immutable metadata", async () => {
      const bytes = Buffer.from("hello attachment", "utf8");
      const record = await saveUploadedAttachment(root, {
        filename: "../../docs/spec.pdf",
        mimeType: "application/pdf",
        data: bytes,
        source: "intake"
      });

      expect(record.filename).toBe("spec.pdf");
      expect(record.size).toBe(bytes.byteLength);
      expect(record.source).toBe("intake");
      expect(record.mimeType).toBe("application/pdf");
      expect(isAttachmentId(record.id)).toBe(true);

      // Blob is stored id-keyed; registry maps back to the same record.
      const blob = await readFile(path.join(attachmentsFilesDir(root), record.id));
      expect(blob.equals(bytes)).toBe(true);
      const resolved = await requireAttachments(root, [record.id]);
      expect(resolved[0]).toEqual(record);
    });

    it("rejects oversize uploads before touching the filesystem", async () => {
      await expect(
        saveUploadedAttachment(root, {
          filename: "big.bin",
          data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
          source: "workflow"
        })
      ).rejects.toThrow("limit");
    });
  });

  describe("remote import + dedup", () => {
    it("deduplicates by source key across repeated imports", async () => {
      const bytes = Buffer.from("upstream", "utf8");
      const first = await saveRemoteAttachment(root, {
        filename: "screenshot.png",
        bytes,
        sourceUrl: "https://clickup.example/a.png",
        sourceKey: "clickup:t1:a1"
      });
      const existing = await findAttachmentBySourceKey(root, "clickup:t1:a1");
      expect(existing?.id).toBe(first.id);

      // A second import with the same key should resolve to the same record
      // (caller checks first, so it never re-downloads).
      const again = await findAttachmentBySourceKey(root, "clickup:t1:a1");
      expect(again?.id).toBe(first.id);
      expect(await stat(path.join(attachmentsFilesDir(root), first.id))).toBeTruthy();
    });

    it("records source traceability for imported attachments", async () => {
      const record = await saveRemoteAttachment(root, {
        filename: "log.txt",
        bytes: Buffer.from("lines"),
        sourceUrl: "https://clickup.example/log.txt",
        sourceKey: "clickup:t2:l1"
      });
      expect(record.source).toBe("clickup");
      expect(record.sourceUrl).toBe("https://clickup.example/log.txt");
      expect(record.sourceKey).toBe("clickup:t2:l1");
    });
  });

  describe("requireAttachments", () => {
    it("throws on unknown ids so dangling references cannot be persisted", async () => {
      await expect(requireAttachments(root, ["11111111-1111-4111-8111-111111111111"])).rejects.toThrow(
        "Unknown attachment"
      );
    });

    it("rejects prototype-polluting and non-uuid ids instead of resolving inherited members", async () => {
      for (const id of ["__proto__", "constructor", "prototype", "not-a-uuid"]) {
        await expect(requireAttachments(root, [id])).rejects.toThrow("Unknown attachment");
      }
    });
  });

  describe("attachmentBlobPath", () => {
    it("returns a path for known attachments and undefined otherwise", async () => {
      const record = await saveUploadedAttachment(root, {
        filename: "note.md",
        data: Buffer.from("# hi"),
        source: "workflow"
      });
      expect(await attachmentBlobPath(root, record.id)).toBe(
        path.join(attachmentsFilesDir(root), record.id)
      );
      expect(await attachmentBlobPath(root, "../../etc/passwd")).toBeUndefined();
    });
  });

  describe("formatAttachmentReference", () => {
    it("renders the readable blob path plus filename, size, and mime", () => {
      const attachment = stubAttachment();
      const reference = formatAttachmentReference(root, attachment);
      // Path is the id-keyed blob under the harness root so the agent can read it.
      expect(reference).toContain(path.join(attachmentsFilesDir(root), attachment.id));
      expect(reference).toContain(`filename "${attachment.filename}"`);
      expect(reference).toContain(`${attachment.size} bytes`);
      expect(reference).toContain(attachment.mimeType);
    });
  });

  describe("withAttachmentReferences", () => {
    it("returns the body unchanged when there are no attachments", () => {
      expect(withAttachmentReferences("see this", root, [])).toBe("see this");
      expect(withAttachmentReferences("see this", root, undefined)).toBe("see this");
    });

    it("appends an agent-readable attachment block with blob paths", () => {
      const first = stubAttachment({ id: "11111111-1111-4111-8111-111111111111" });
      const second = stubAttachment({
        id: "22222222-2222-4222-8222-222222222222",
        filename: "data.csv",
        mimeType: "text/csv",
        size: 10
      });
      const result = withAttachmentReferences("See attached", root, [first, second]);
      expect(result.startsWith("See attached\n\nAttachments:\n")).toBe(true);
      expect(result).toContain(formatAttachmentReference(root, first));
      expect(result).toContain(formatAttachmentReference(root, second));
    });
  });
});
