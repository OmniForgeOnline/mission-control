import { createReadStream } from "node:fs";

import { Router } from "express";

import {
  attachmentBlobPath,
  getAttachment,
  isAttachmentId,
  saveUploadedAttachment
} from "../../core/attachments/store.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

interface UploadBody {
  filename?: unknown;
  mimeType?: unknown;
  data?: unknown;
  source?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Strip a leading `data:...;base64,` prefix a client might send by accident. */
function decodeBase64Body(raw: string): Buffer {
  const match = raw.match(/^data:[^;]*;base64,(.*)$/s);
  return Buffer.from(match?.[1] ?? raw, "base64");
}

export function createAttachmentsRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/attachments",
    asyncRoute(async (req, res) => {
      const body = req.body as UploadBody;
      const filename = asString(body.filename)?.trim();
      const data = asString(body.data);
      if (!filename) {
        res.status(400).json({ error: "filename is required." });
        return;
      }
      if (!data) {
        res.status(400).json({ error: "data (base64) is required." });
        return;
      }
      const source = asString(body.source) === "intake" ? "intake" : "workflow";
      const bytes = decodeBase64Body(data);
      if (bytes.byteLength === 0) {
        res.status(400).json({ error: "Attachment is empty." });
        return;
      }
      const mimeType = asString(body.mimeType);
      try {
        const attachment = await saveUploadedAttachment(options.root, {
          filename,
          ...(mimeType ? { mimeType } : {}),
          data: bytes,
          source
        });
        res.status(201).json(attachment);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    })
  );

  router.get(
    "/attachments/:id",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      if (!isAttachmentId(id)) {
        res.status(404).json({ error: "Attachment not found." });
        return;
      }
      const attachment = await getAttachment(options.root, id);
      if (!attachment) {
        res.status(404).json({ error: "Attachment not found." });
        return;
      }
      const filePath = await attachmentBlobPath(options.root, id);
      if (!filePath) {
        res.status(404).json({ error: "Attachment blob is missing." });
        return;
      }
      // Force download with the stored filename; never inline-render uploaded
      // content. sanitizeFilename already removed quotes, so the header is safe.
      res.setHeader("Content-Type", attachment.mimeType);
      res.setHeader("Content-Length", String(attachment.size));
      res.setHeader("Content-Disposition", `attachment; filename="${attachment.filename}"`);
      createReadStream(filePath).on("error", () => {
        if (!res.headersSent) res.status(500).json({ error: "Failed to read attachment." });
        res.end();
      }).pipe(res);
    })
  );

  return router;
}
