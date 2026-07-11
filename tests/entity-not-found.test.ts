import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { EntityNotFoundError } from "../src/core/tasks/errors.ts";
import { updateRun } from "../src/core/tasks/runs.ts";
import { updateTask } from "../src/core/tasks/tasks.ts";

describe("EntityNotFoundError", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-entity-not-found-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("updateRun throws a typed run error with the preserved message", async () => {
    const thrown = await updateRun(root, "run-missing", { status: "completed" }).catch((err) => err);

    expect(thrown).toBeInstanceOf(EntityNotFoundError);
    expect(thrown).toHaveProperty("kind", "run");
    expect(thrown).toHaveProperty("id", "run-missing");
    expect((thrown as Error).message).toBe("Run not found: run-missing");
  });

  it("updateTask throws a typed task error with the preserved message", async () => {
    const thrown = await updateTask(root, "task-missing", (task) => task).catch((err) => err);

    expect(thrown).toBeInstanceOf(EntityNotFoundError);
    expect(thrown).toHaveProperty("kind", "task");
    expect(thrown).toHaveProperty("id", "task-missing");
    expect((thrown as Error).message).toBe("Task not found: task-missing");
  });

  // The detached-turn cleanup in src/daemon/agent-turn.ts guards on
  // `updateErr instanceof EntityNotFoundError`. Matching must be type-based so a
  // future message-text change cannot silently re-enable the crash that
  // 0ca3b1e suppressed (the old guard compared `.message` strings).
  it("the cleanup guard matches by type, not message text", () => {
    const swallowed = (err: unknown): boolean => err instanceof EntityNotFoundError;

    const typed = new EntityNotFoundError("run", "r1");
    typed.message = "future reworded message";
    expect(swallowed(typed)).toBe(true);

    // A plain Error carrying the historical text is NOT matched — the old
    // string guard would have kept coupling to it.
    expect(swallowed(new Error("Run not found: r1"))).toBe(false);
  });
});
