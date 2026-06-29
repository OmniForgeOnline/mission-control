import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  cancelIdleUpdate,
  hasQueuedIdleUpdate,
  pollIdleUpdateNow,
  resetVersionCache
} from "../src/core/system/update.ts";

function registryLatest(version: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version })
    }))
  );
}

describe("version + update routes", () => {
  let root: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-version-api-"));
    await ensureHarnessRepository(root);
    packageRoot = await mkdtemp(path.join(tmpdir(), "harness-version-api-pkg-"));
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "server.js"), "// built\n");
    await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await writeFile(path.join(packageRoot, "scripts", "apply-update.mjs"), "// dummy updater\n");
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@omniforge/mission-control", version: "0.1.3" })
    );
    resetVersionCache();
    cancelIdleUpdate();
    registryLatest("0.1.4");
  });

  afterEach(async () => {
    cancelIdleUpdate();
    vi.unstubAllGlobals();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(packageRoot, { recursive: true, force: true })
    ]);
  });

  function app(overrides: { updateSpawn?: () => boolean; updateExit?: () => void } = {}) {
    return createServer({
      root,
      packageRoot,
      testMode: true,
      ...(overrides.updateSpawn ? { updateSpawn: overrides.updateSpawn } : {}),
      ...(overrides.updateExit ? { updateExit: overrides.updateExit } : {})
    });
  }

  it("GET /version reports installed, latest, behind, and canSelfUpdate", async () => {
    const res = await request(app()).get("/api/version");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: "0.1.3",
      latest: "0.1.4",
      behind: true,
      canSelfUpdate: true
    });
  });

  it("GET /version reports not behind when installed matches latest", async () => {
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@omniforge/mission-control", version: "0.1.4" })
    );
    const res = await request(app()).get("/api/version");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ installed: "0.1.4", behind: false });
  });

  it("rejects an unknown apply mode", async () => {
    const res = await request(app()).post("/api/update/apply").send({ mode: "bogus" });
    expect(res.status).toBe(400);
  });

  it("mode=now stops work, spawns the updater, and schedules exit", async () => {
    const updateSpawn = vi.fn(() => true);
    const updateExit = vi.fn();
    const res = await request(app({ updateSpawn, updateExit }))
      .post("/api/update/apply")
      .send({ mode: "now" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applying: true });
    expect(res.body.stopped).toBeDefined();
    expect(updateSpawn).toHaveBeenCalledTimes(1);
    expect(updateExit).toHaveBeenCalledTimes(1);
  });

  it("mode=now returns 500 and does not exit when the updater cannot spawn", async () => {
    const updateExit = vi.fn();
    const res = await request(app({ updateSpawn: () => false, updateExit }))
      .post("/api/update/apply")
      .send({ mode: "now" });
    expect(res.status).toBe(500);
    expect(updateExit).not.toHaveBeenCalled();
  });

  it("mode=idle queues an update without exiting, then applies on idle", async () => {
    const updateSpawn = vi.fn(() => true);
    const updateExit = vi.fn();
    const res = await request(app({ updateSpawn, updateExit }))
      .post("/api/update/apply")
      .send({ mode: "idle" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: true });
    expect(updateExit).not.toHaveBeenCalled();
    expect(hasQueuedIdleUpdate()).toBe(true);

    await pollIdleUpdateNow();
    expect(hasQueuedIdleUpdate()).toBe(false);
    expect(updateSpawn).toHaveBeenCalledTimes(1);
    expect(updateExit).toHaveBeenCalledTimes(1);
  });

  it("gates apply when the install has no built server entry", async () => {
    await rm(path.join(packageRoot, "dist", "server.js"));
    const res = await request(app()).post("/api/update/apply").send({ mode: "now" });
    expect(res.status).toBe(409);
  });
});
