import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";
import {
  beginInteractiveWait,
  resetInteractiveControlForTests
} from "../src/terminal/interactive-control.ts";

describe("interactive complete API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-int-api-"));
    await ensureHarnessRepository(root);
    resetInteractiveControlForTests();
  });

  afterEach(async () => {
    resetInteractiveControlForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("completes a waiting interactive turn", async () => {
    const app = createServer({ root, testMode: true });
    const pending = beginInteractiveWait("task-x", { terminalSessionId: "term_1", runId: "run_1" });

    const res = await request(app)
      .post("/api/tasks/task-x/interactive/complete")
      .send({ outcome: "done", note: "ship it" })
      .expect(200);

    expect(res.body.completed).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "done", note: "ship it" });
  });

  it("returns 409 when no interactive wait is active", async () => {
    const app = createServer({ root, testMode: true });
    await request(app)
      .post("/api/tasks/nope/interactive/complete")
      .send({ outcome: "done" })
      .expect(409);
  });

  it("exposes interactiveSessions on /api/state", async () => {
    const app = createServer({ root, testMode: true });
    beginInteractiveWait("task-state", { terminalSessionId: "term_s" });
    const res = await request(app).get("/api/state").expect(200);
    expect(res.body.interactiveSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "task-state", terminalSessionId: "term_s" })
      ])
    );
  });
});
