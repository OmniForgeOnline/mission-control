import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  fetchLatestVersion,
  getVersionStatus,
  isSystemIdle,
  stopAllWork,
  readUpdateOutcome,
  writeUpdateOutcome,
  applyUpdate,
  queueIdleUpdate,
  hasQueuedIdleUpdate,
  cancelIdleUpdate,
  pollIdleUpdateNow,
  resetVersionCache,
  type ApplyContext,
  type RegistryFetch
} from "../src/core/system/update.ts";
import { createRun, listAllRuns } from "../src/core/tasks/runs.ts";
import {
  abortAllInflightTurns,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { AgentRunner } from "../src/runners/types.ts";

function mockRunner(): AgentRunner {
  return {
    agent: "codex",
    abort() {},
    runTurn: () => new Promise(() => {})
  } as unknown as AgentRunner;
}

function registry(body: string, ok = true): RegistryFetch {
  return async () => ({ ok, status: ok ? 200 : 500, text: async () => body });
}

describe("fetchLatestVersion", () => {
  beforeEach(() => resetVersionCache());

  it("parses the version from the registry payload", async () => {
    const res = await fetchLatestVersion("@omniforge/mission-control", registry(JSON.stringify({ version: "0.2.0" })));
    expect(res.version).toBe("0.2.0");
    expect(res.fetchedAt).not.toBeNull();
  });

  it("serves a cached result without re-fetching within the TTL", async () => {
    let calls = 0;
    const fetchFn: RegistryFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ version: "0.2.0" }) };
    };
    await fetchLatestVersion("@omniforge/mission-control", fetchFn);
    const second = await fetchLatestVersion("@omniforge/mission-control", fetchFn);
    expect(calls).toBe(1);
    expect(second.version).toBe("0.2.0");
  });

  it("returns null on a failed fetch and keeps a stale cache when present", async () => {
    await fetchLatestVersion("@omniforge/mission-control", registry(JSON.stringify({ version: "0.2.0" })));
    const res = await fetchLatestVersion("@omniforge/mission-control", registry("nope", false));
    expect(res.version).toBe("0.2.0");
    resetVersionCache();
    const none = await fetchLatestVersion("@omniforge/mission-control", registry("nope", false));
    expect(none.version).toBeNull();
  });

  it("returns null without a package name", async () => {
    const res = await fetchLatestVersion(null, registry(JSON.stringify({ version: "0.2.0" })));
    expect(res.version).toBeNull();
  });
});

describe("getVersionStatus", () => {
  beforeEach(() => resetVersionCache());

  it("flags behind and gates self-update on the built server entry", async () => {
    const behind = await getVersionStatus({
      packageRoot: "/nonexistent-package-root",
      packageName: "@omniforge/mission-control",
      installed: "0.1.3",
      fetch: registry(JSON.stringify({ version: "0.1.4" }))
    });
    expect(behind.behind).toBe(true);
    expect(behind.latest).toBe("0.1.4");
    expect(behind.canSelfUpdate).toBe(false);

    const current = await getVersionStatus({
      packageRoot: "/nonexistent-package-root",
      packageName: "@omniforge/mission-control",
      installed: "0.1.4",
      fetch: registry(JSON.stringify({ version: "0.1.4" }))
    });
    expect(current.behind).toBe(false);
  });
});

describe("isSystemIdle + stopAllWork", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-update-"));
    await ensureHarnessRepository(root);
    abortAllInflightTurns();
    resetVersionCache();
  });

  afterEach(async () => {
    abortAllInflightTurns();
    await rm(root, { recursive: true, force: true });
  });

  it("is idle with no runs and no inflight turns", async () => {
    await expect(isSystemIdle(root)).resolves.toBe(true);
  });

  it("is busy while a run is running", async () => {
    await createRun(root, {
      taskId: "task-1",
      taskTitle: "Example",
      agent: "codex",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    await expect(isSystemIdle(root)).resolves.toBe(false);
  });

  it("is busy while a turn is inflight", async () => {
    registerInflightTurn("task-2", mockRunner());
    expect(listInflightTaskIds()).toContain("task-2");
    await expect(isSystemIdle(root)).resolves.toBe(false);
  });

  it("stops all running work: pauses runs and aborts inflight turns", async () => {
    await createRun(root, {
      taskId: "task-1",
      taskTitle: "Example",
      agent: "codex",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    registerInflightTurn("task-1", mockRunner());

    const result = await stopAllWork(root);
    expect(result.runs).toBe(1);
    expect(result.aborted).toBeGreaterThanOrEqual(1);

    const runs = await listAllRuns(root);
    expect(runs.every((run) => run.status !== "running")).toBe(true);
    expect(listInflightTaskIds()).toHaveLength(0);
    await expect(isSystemIdle(root)).resolves.toBe(true);
  });
});

describe("update status file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-update-status-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips an outcome and ignores stale or malformed files", async () => {
    await expect(readUpdateOutcome(root)).resolves.toBeNull();

    await writeUpdateOutcome(root, {
      result: "ok",
      from: "0.1.3",
      to: "0.1.4",
      at: new Date().toISOString()
    });
    await expect(readUpdateOutcome(root)).resolves.toMatchObject({ result: "ok", to: "0.1.4" });

    // Stale (>1h old) outcomes are ignored.
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeUpdateOutcome(root, { result: "ok", from: "0.1.3", to: "0.1.4", at: stale });
    await expect(readUpdateOutcome(root)).resolves.toBeNull();

    // Malformed JSON is ignored.
    const file = path.join(root, ".mission-control", "update-status.json");
    await writeFile(file, "{not json");
    await expect(readUpdateOutcome(root)).resolves.toBeNull();
  });
});

describe("applyUpdate orchestration", () => {
  let root: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-apply-root-"));
    packageRoot = await mkdtemp(path.join(tmpdir(), "harness-apply-pkg-"));
    await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await writeFile(path.join(packageRoot, "scripts", "apply-update.mjs"), "// dummy updater\n");
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "server.js"), "// built\n");
    resetVersionCache();
  });
  afterEach(async () => {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(packageRoot, { recursive: true, force: true })]);
  });

  function baseCtx(overrides: Partial<ApplyContext> = {}): ApplyContext {
    return {
      root,
      packageRoot,
      packageName: "@omniforge/mission-control",
      fromVersion: "0.1.3",
      spawnUpdater: vi.fn(() => true),
      scheduleExit: vi.fn(),
      ...overrides
    };
  }

  it("copies the updater to a temp file, spawns it detached with env, and schedules exit", async () => {
    const spawnUpdater = vi.fn<(script: string, env: NodeJS.ProcessEnv) => boolean>(() => true);
    const scheduleExit = vi.fn();
    const res = await applyUpdate(baseCtx({ spawnUpdater, scheduleExit }));
    expect(res.spawned).toBe(true);
    expect(spawnUpdater).toHaveBeenCalledTimes(1);
    const call = spawnUpdater.mock.calls[0];
    expect(call).toBeDefined();
    const [script, env] = (call ?? ["", {}]) as [string, NodeJS.ProcessEnv];
    expect(script).toContain("mc-apply-update");
    expect(env["MC_UPDATE_PACKAGE"]).toBe("@omniforge/mission-control");
    expect(env["MC_UPDATE_ORIG_ROOT"]).toBe(packageRoot);
    expect(env["MC_UPDATE_HARNESS_ROOT"]).toBe(root);
    expect(env["MC_UPDATE_FROM_VERSION"]).toBe("0.1.3");
    expect(scheduleExit).toHaveBeenCalled();
  });

  it("does not schedule exit when the updater fails to spawn", async () => {
    const scheduleExit = vi.fn();
    const res = await applyUpdate(baseCtx({ spawnUpdater: () => false, scheduleExit }));
    expect(res.spawned).toBe(false);
    expect(scheduleExit).not.toHaveBeenCalled();
  });
});

describe("deferred idle update", () => {
  let root: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-idle-root-"));
    packageRoot = await mkdtemp(path.join(tmpdir(), "harness-idle-pkg-"));
    await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await writeFile(path.join(packageRoot, "scripts", "apply-update.mjs"), "// dummy\n");
    await ensureHarnessRepository(root);
    abortAllInflightTurns();
    resetVersionCache();
    cancelIdleUpdate();
  });
  afterEach(async () => {
    cancelIdleUpdate();
    abortAllInflightTurns();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(packageRoot, { recursive: true, force: true })]);
  });

  it("does not apply while busy, then applies exactly once on the idle transition", async () => {
    const spawnUpdater = vi.fn(() => true);
    const scheduleExit = vi.fn();
    queueIdleUpdate({
      root,
      packageRoot,
      packageName: "@omniforge/mission-control",
      fromVersion: "0.1.3",
      spawnUpdater,
      scheduleExit
    });
    expect(hasQueuedIdleUpdate()).toBe(true);

    registerInflightTurn("task-busy", mockRunner());
    await pollIdleUpdateNow();
    expect(spawnUpdater).not.toHaveBeenCalled();
    expect(hasQueuedIdleUpdate()).toBe(true);

    abortAllInflightTurns();
    await pollIdleUpdateNow();
    expect(spawnUpdater).toHaveBeenCalledTimes(1);
    expect(scheduleExit).toHaveBeenCalled();
    expect(hasQueuedIdleUpdate()).toBe(false);

    // A second tick does not re-apply (the queued update is consumed).
    await pollIdleUpdateNow();
    expect(spawnUpdater).toHaveBeenCalledTimes(1);
  });
});
