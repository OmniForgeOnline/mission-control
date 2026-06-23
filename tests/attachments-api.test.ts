import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentsFilesDir
} from "../src/core/attachments/store.ts";
import {
  clearInflightTurn,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import type { LiveAgentRunner } from "../src/runners/types.ts";

describe("attachment API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-attachments-api-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    for (const taskId of listInflightTaskIds()) clearInflightTurn(taskId);
    await rm(root, { recursive: true, force: true });
  });

  it("uploads, downloads, and attaches files to tickets and step replies", async () => {
    const app = createServer({ root });

    const payload = Buffer.from("ticket attachment body", "utf8");
    const upload = await request(app)
      .post("/api/attachments")
      .send({
        filename: "../../etc/leaked.pdf",
        mimeType: "application/pdf",
        source: "intake",
        data: payload.toString("base64")
      })
      .expect(201);

    const attachment = upload.body;
    expect(attachment.filename).toBe("leaked.pdf");
    expect(attachment.size).toBe(payload.byteLength);

    // Download returns the bytes and forces a download disposition.
    const downloaded = await request(app).get(`/api/attachments/${attachment.id}`).expect(200);
    expect(Buffer.from(downloaded.body).equals(payload)).toBe(true);
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(downloaded.headers["content-disposition"]).toContain("leaked.pdf");

    // Ticket intake carries the attachment through to the created task.
    const task = await request(app)
      .post("/api/tasks")
      .send({
        title: "Has attachment",
        description: "Created with an attached file",
        source: "intake",
        attachmentIds: [attachment.id]
      })
      .expect(201);
    expect(task.body.attachments?.[0]?.id).toBe(attachment.id);
    expect(task.body.attachments?.[0]?.filename).toBe("leaked.pdf");

    // A step reply (note only, so no agent turn runs) embeds attachments on the message.
    const message = await request(app)
      .post(`/api/tasks/${task.body.id}/messages`)
      .send({ body: "See attached", stepId: "implement", noteOnly: true, attachmentIds: [attachment.id] })
      .expect(201);
    expect(message.body.message.attachments?.[0]?.id).toBe(attachment.id);
  });

  it("rejects unknown attachment ids so dangling references cannot be persisted", async () => {
    const app = createServer({ root });
    await request(app)
      .post("/api/tasks")
      .send({
        title: "Bad ref",
        description: "References a missing attachment",
        source: "intake",
        attachmentIds: ["11111111-1111-4111-8111-111111111111"]
      })
      .expect(400);
  });

  it("refuses to store oversize uploads", async () => {
    const app = createServer({ root });
    await request(app)
      .post("/api/attachments")
      .send({
        filename: "huge.bin",
        data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")
      })
      .expect(400);
  });

  it("does not serve traversal-shaped ids", async () => {
    const app = createServer({ root });
    await request(app).get("/api/attachments/..%2F..%2Fetc%2Fpasswd").expect(404);
  });

  it("delivers step-reply attachment refs to a live agent turn", async () => {
    const app = createServer({ root });

    const payload = Buffer.from("live attachment body", "utf8");
    const upload = await request(app)
      .post("/api/attachments")
      .send({
        filename: "plan.pdf",
        mimeType: "application/pdf",
        source: "workflow",
        data: payload.toString("base64")
      })
      .expect(201);
    const attachmentId = upload.body.id as string;

    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Live reply", description: "Has an attached file", source: "intake" })
      .expect(201);
    const taskId = task.body.id as string;

    // Register a live runner for this task that records what it is handed.
    const received: string[] = [];
    const runner: LiveAgentRunner = {
      agent: "claude",
      supportsMidTurnInput: true,
      runTurn: async () => ({ reply: "", exitCode: 0, command: "fake", rawLog: "" }),
      abort: () => {},
      sendOperatorMessage: (text: string) => {
        received.push(text);
        return true;
      }
    };
    registerInflightTurn(taskId, runner, "run-live");

    const message = await request(app)
      .post(`/api/tasks/${taskId}/messages`)
      .send({ body: "See attached", attachmentIds: [attachmentId] })
      .expect(201);

    // The live turn accepted the message (no follow-up turn was scheduled).
    expect(message.body.turn?.execution).toBe("running");
    expect(message.body.turn?.runId).toBe("run-live");
    // The agent received the body AND a readable reference to the blob.
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("See attached");
    expect(received[0]).toContain(path.join(attachmentsFilesDir(root), attachmentId));
    expect(received[0]).toContain('filename "plan.pdf"');
    expect(received[0]).toContain(`${payload.byteLength} bytes`);
  });
});
