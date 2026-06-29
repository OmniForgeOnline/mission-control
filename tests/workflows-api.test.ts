import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { WorkflowDefinition } from "../src/core/workflows/index.ts";
import { workflowFilePath } from "../src/core/workflows/index.ts";
import { resetWorkflowCache } from "../src/core/workflows/index.ts";
import { startServer, stopServer } from "./helpers/server.ts";

function buildWorkflow(id: string): WorkflowDefinition {
  return {
    id,
    name: id,
    initial: "do",
    defaults: { author: "claude", reviewer: "codex", effort: "medium" },
    steps: {
      do: {
        id: "do",
        kind: "agent_turn",
        agent: "author",
        effort: "high",
        approval: "required",
        next: "done"
      },
      done: { id: "done", kind: "terminal", agent: "none", approval: "none" }
    }
  };
}

describe("workflows api", () => {
  let root: string;
  let server: http.Server;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-workflows-api-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
    server = await startServer({ root });
  });

  afterEach(async () => {
    resetWorkflowCache();
    await stopServer(server);
    await rm(root, { recursive: true, force: true });
  });

  it("lists seeded workflows including the migrated bugfix author", async () => {
    const res = await request(server).get("/api/workflows");
    expect(res.status).toBe(200);
    const ids = (res.body as WorkflowDefinition[]).map((w) => w.id);
    expect(ids).toContain("code-feature");
    expect(ids).toContain("bugfix");
    const bugfix = (res.body as Array<{ id: string; defaults: { author: string } }>).find((w) => w.id === "bugfix");
    expect(bugfix?.defaults.author).toBe("claude");
  });

  it("returns a full definition by id and 404 for unknown", async () => {
    const ok = await request(server).get("/api/workflows/code-feature");
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe("code-feature");
    expect(ok.body.defaults.author).toBe("claude");

    const missing = await request(server).get("/api/workflows/does-not-exist");
    expect(missing.status).toBe(404);
  });

  it("creates a new workflow, persists it to YAML, and rejects duplicate ids", async () => {
    const created = await request(server).post("/api/workflows").send(buildWorkflow("my-flow"));
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("my-flow");

    const onDisk = await readFile(workflowFilePath(root, "my-flow"), "utf8");
    expect(onDisk).toContain("id: my-flow");

    const fetched = await request(server).get("/api/workflows/my-flow");
    expect(fetched.status).toBe(200);

    const duplicate = await request(server).post("/api/workflows").send(buildWorkflow("code-feature"));
    expect(duplicate.status).toBe(409);
  });

  it("rejects an invalid workflow without writing a file", async () => {
    const invalid = buildWorkflow("bad-flow");
    (invalid.steps["do"] as { kind: string }).kind = "bogus";
    const res = await request(server).post("/api/workflows").send(invalid);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    await expect(readFile(workflowFilePath(root, "bad-flow"), "utf8")).rejects.toThrow();
  });

  it("updates an existing workflow and invalidates the cache", async () => {
    await request(server).post("/api/workflows").send(buildWorkflow("editable"));

    const updated = buildWorkflow("editable");
    updated.name = "Edited Name";
    const res = await request(server).put("/api/workflows/editable").send(updated);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Edited Name");

    // Cache must have been reset so the next read reflects the new name.
    const reread = await request(server).get("/api/workflows/editable");
    expect(reread.body.name).toBe("Edited Name");

    const missing = await request(server)
      .put("/api/workflows/never-existed")
      .send(buildWorkflow("never-existed"));
    expect(missing.status).toBe(404);
  });

  it("deletes a workflow but protects the default workflow", async () => {
    await request(server).post("/api/workflows").send(buildWorkflow("deletable"));

    const removed = await request(server).delete("/api/workflows/deletable");
    expect(removed.status).toBe(204);
    const after = await request(server).get("/api/workflows/deletable");
    expect(after.status).toBe(404);

    const protectDefault = await request(server).delete("/api/workflows/code-feature");
    expect(protectDefault.status).toBe(400);
  });

  it("dry-runs validation without writing", async () => {
    const valid = await request(server).post("/api/workflows/validate").send(buildWorkflow("preview"));
    expect(valid.status).toBe(200);
    expect(valid.body).toHaveProperty("valid", true);
    await expect(readFile(workflowFilePath(root, "preview"), "utf8")).rejects.toThrow();

    const bad = buildWorkflow("preview");
    (bad.steps["do"] as { kind: string }).kind = "nope";
    const invalid = await request(server).post("/api/workflows/validate").send(bad);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toHaveProperty("valid", false);
  });

  it("round-trips a definition through serialize and parse", async () => {
    const def = buildWorkflow("yaml-toggle");
    const ser = await request(server).post("/api/workflows/serialize").send(def);
    expect(ser.status).toBe(200);
    expect(ser.body.yaml).toContain("id: yaml-toggle");

    const parsed = await request(server)
      .post("/api/workflows/parse")
      .send({ yaml: ser.body.yaml as string });
    expect(parsed.status).toBe(200);
    expect(parsed.body.workflow).toMatchObject({ id: "yaml-toggle" });

    const broken = await request(server).post("/api/workflows/parse").send({ yaml: "id: x\nsteps: {}\n" });
    expect(broken.status).toBe(400);
    expect(broken.body).toHaveProperty("error");
  });
});
