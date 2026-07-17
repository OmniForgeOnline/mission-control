import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";
import {
  createSessionManager,
  type PtyHandle,
  type PtySpawnOptions
} from "../src/terminal/session-manager.ts";
import { setTerminalSessionManagerForTests } from "../src/terminal/manager.ts";

function fakeSpawn(_opts: PtySpawnOptions): PtyHandle {
  return {
    pid: 1,
    cols: 80,
    rows: 24,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit() {}
  };
}

describe("terminal REST API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-term-api-"));
    await ensureHarnessRepository(root);
    setTerminalSessionManagerForTests(createSessionManager({ spawn: fakeSpawn }));
  });

  afterEach(async () => {
    setTerminalSessionManagerForTests(null);
    await rm(root, { recursive: true, force: true });
  });

  it("creates a shell session and lists it", async () => {
    const app = createServer({ root, testMode: true });
    const created = await request(app)
      .post("/api/terminal/sessions")
      .send({ kind: "shell", cwd: root, cols: 100, rows: 32 })
      .expect(201);

    expect(created.body.id).toMatch(/^term_/);
    expect(created.body.alive).toBe(true);
    expect(created.body.cwd).toBe(path.resolve(root));

    const list = await request(app).get("/api/terminal/sessions").expect(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].id).toBe(created.body.id);
  });

  it("disposes a session", async () => {
    const app = createServer({ root, testMode: true });
    const created = await request(app)
      .post("/api/terminal/sessions")
      .send({ kind: "shell", cwd: root })
      .expect(201);

    await request(app).delete(`/api/terminal/sessions/${created.body.id}`).expect(204);
    await request(app).get(`/api/terminal/sessions/${created.body.id}`).expect(404);
  });
});
