import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { readRuntimeAssetsManifest } from "../src/core/bootstrap/runtime-assets/index.ts";
import { workflowFilePath, resetWorkflowCache } from "../src/core/workflows/cache.ts";
import { bundledWorkflowsDir } from "../src/core/workflows/paths.ts";
import { createServer } from "../src/server/app.ts";

describe("runtime assets API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-runtime-assets-api-"));
    resetWorkflowCache();
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("lists pending review assets and supports keep/reset", async () => {
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.workflows["bugfix"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const app = createServer({ root, testMode: true });
    const listed = await request(app).get("/api/runtime-assets").expect(200);
    expect(listed.body.migration.pendingReview.workflows).toContain("bugfix");

    const diff = await request(app).get("/api/runtime-assets/workflow/bugfix/diff").expect(200);
    expect(diff.body.runtimeBody).toContain("Operator Bugfix");
    expect(diff.body.bundledBody).toContain("name: Bugfix");

    await request(app).post("/api/runtime-assets/workflow/bugfix/keep").expect(200);
    const afterKeep = await request(app).get("/api/runtime-assets").expect(200);
    expect(afterKeep.body.migration.pendingReview.workflows).not.toContain("bugfix");

    await request(app).post("/api/runtime-assets/workflow/bugfix/reset").expect(200);
    expect(await readFile(workflowFilePath(root, "bugfix"), "utf8")).toContain("name: Bugfix");
  });
});
