import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { readSkill } from "../src/core/catalog/skills-catalog.ts";
import { createServer } from "../src/server/app.ts";

describe("skills write api", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-skills-write-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a new body and round-trips while preserving frontmatter", async () => {
    const app = createServer({ root });
    const before = await readSkill(root, "harness-turn-loop");
    expect(before.content).toContain("name: harness-turn-loop");

    const newBody = "# Rewritten\n\nThis is the operator-edited body.\n";
    const res = await request(app).put("/api/skills/harness-turn-loop").send({ content: newBody });

    expect(res.status).toBe(200);
    const body = res.body as { name: string; content: string };
    expect(body.name).toBe("harness-turn-loop");
    // frontmatter survives the edit
    expect(body.content).toContain("name: harness-turn-loop");
    expect(body.content).toContain("This is the operator-edited body.");

    // persisted to disk
    const after = await readSkill(root, "harness-turn-loop");
    expect(after.content).toBe(body.content);
    expect(after.content).toContain("name: harness-turn-loop");
    expect(after.content).toContain("This is the operator-edited body.");
  });

  it("writes verbatim when the incoming content already carries frontmatter", async () => {
    const app = createServer({ root });
    const full = "---\nname: harness-turn-loop\ndescription: Updated desc\n---\n\nNew body.\n";
    const res = await request(app).put("/api/skills/harness-turn-loop").send({ content: full });

    expect(res.status).toBe(200);
    const after = await readSkill(root, "harness-turn-loop");
    expect(after.content).toBe(full);
    expect(after.content).toContain("description: Updated desc");
  });

  it("rejects an invalid skill name with 400", async () => {
    const app = createServer({ root });
    const res = await request(app).put("/api/skills/Invalid Name").send({ content: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-string content body with 400", async () => {
    const app = createServer({ root });
    const res = await request(app).put("/api/skills/harness-turn-loop").send({ content: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown skill", async () => {
    const app = createServer({ root });
    const res = await request(app).put("/api/skills/does-not-exist").send({ content: "x" });
    expect(res.status).toBe(404);
  });
});
