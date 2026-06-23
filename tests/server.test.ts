import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createServer } from "../src/server/app.ts";
import {
  abortAllInflightTurns,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import { emitStateChange, taskScopes } from "../src/core/infra/state-bus.ts";
import { computeQualityGrades } from "../src/core/quality/quality.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { approveTask, setTaskStatus } from "../src/core/tasks/tasks.ts";
import type { AgentRunner } from "../src/runners/types.ts";

class MockRunner implements AgentRunner {
  agent = "codex" as const;
  aborted = false;

  abort(): void {
    this.aborted = true;
  }

  runTurn(): Promise<never> {
    return new Promise(() => {});
  }
}

describe("server routes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-server-"));
    await ensureHarnessRepository(root);
    abortAllInflightTurns();
  });

  afterEach(async () => {
    abortAllInflightTurns();
    await rm(root, { recursive: true, force: true });
  });

  async function withSseServer(
    handler: (port: number, abort: () => void) => Promise<void>
  ): Promise<void> {
    const app = createServer({ root, testMode: true });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      await handler(port, () => controller.abort());
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  it("returns SSE headers for /api/events", async () => {
    await withSseServer(async (port, abort) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: AbortSignal.timeout(2_000) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");
      abort();
      await res.body?.cancel();
    });
  });

  it("streams state-changed events over /api/events", async () => {
    await withSseServer(async (port, abort) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: AbortSignal.timeout(2_000) });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        emitStateChange(taskScopes("task-1"));
        const chunk = await reader?.read();
        if (chunk?.value) buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.includes("event: state-changed")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(buffer).toContain("event: state-changed");
      expect(buffer).toContain("tasks");
      abort();
      await reader?.cancel();
    });
  });

  it("lists skills and kernel sections", async () => {
    const app = createServer({ root, testMode: true });
    const res = await request(app).get("/api/skills").expect(200);
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(Array.isArray(res.body.kernelSections)).toBe(true);
    expect(res.body.skills.some((skill: { name: string }) => skill.name === "code-review")).toBe(true);
    expect(res.body.kernelSections).toContain("operating-principles");
  });

  it("returns a skill body and 404s unknown skills", async () => {
    const app = createServer({ root, testMode: true });
    const known = await request(app).get("/api/skills/code-review").expect(200);
    expect(known.body.name).toBe("code-review");
    expect(known.body.content).toContain("code-review");

    await request(app).get("/api/skills/not-a-real-skill").expect(404);
  });

  it("returns kernel markdown and 404s unknown sections", async () => {
    const app = createServer({ root, testMode: true });
    const known = await request(app).get("/api/kernel/operating-principles").expect(200);
    expect(known.body.name).toBe("operating-principles");
    expect(known.body.content.length).toBeGreaterThan(0);

    await request(app).get("/api/kernel/not-a-real-section").expect(404);
  });

  it("recomputes quality grades including the server domain", async () => {
    const app = createServer({ root: process.cwd(), testMode: true });
    const res = await request(app).post("/api/quality/recompute").expect(200);
    expect(res.body.domains.server?.grade).toBe("A");
    expect(res.body.domains.server?.rationale).toContain("tests reference this domain");
  });

  it("reports inflight task ids in /api/state", async () => {
    const app = createServer({ root, testMode: true });
    registerInflightTurn("task-live", new MockRunner());

    const res = await request(app).get("/api/state").expect(200);
    expect(res.body.inflightTaskIds).toContain("task-live");
  });

  it("returns aborted true when killing a run with a live inflight turn", async () => {
    const app = createServer({ root, testMode: true });
    const runner = new MockRunner();
    const task = await request(app)
      .post("/api/tasks")
      .send({
        title: "Inflight kill",
        description: "Exercise abortInflightTurn via HTTP.",
        agent: "codex",
        source: "manual",
        links: []
      })
      .expect(201);

    await approveTask(root, task.body.id);
    await setTaskStatus(root, task.body.id, "running");
    const run = await createRun(root, {
      taskId: task.body.id,
      taskTitle: task.body.title,
      agent: "codex",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: ["prompt.md", "log.txt"]
    });
    registerInflightTurn(task.body.id, runner);

    const killed = await request(app).post(`/api/runs/${run.id}/kill`).expect(200);
    expect(killed.body.aborted).toBe(true);
    expect(runner.aborted).toBe(true);
    expect(listInflightTaskIds()).toEqual([]);
  });
});

describe("server quality grade", () => {
  it("grades the server domain A when tests/server.test.ts exists", async () => {
    const quality = await computeQualityGrades(process.cwd());
    expect(quality.domains['server']?.grade).toBe("A");
    expect(quality.domains['server']?.rationale).toBe(
      "Healthy: no oversized files, tests reference this domain."
    );
  });
});