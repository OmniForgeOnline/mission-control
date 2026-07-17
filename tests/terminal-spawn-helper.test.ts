import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureNodePtySpawnHelpersExecutable } from "../src/terminal/spawn-helper.ts";

describe("node-pty spawn-helper permissions", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("sets the execute bit on spawn-helper binaries under prebuilds", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pty-helper-"));
    const helperDir = path.join(dir, "prebuilds", "darwin-arm64");
    mkdirSync(helperDir, { recursive: true });
    const helper = path.join(helperDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\necho ok\n");
    chmodSync(helper, 0o644);

    const fixed = ensureNodePtySpawnHelpersExecutable(dir);
    expect(fixed).toContain(helper);
    expect(statSync(helper).mode & 0o111).toBeTruthy();
  });

  it("is a no-op when helpers are already executable", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pty-helper-ok-"));
    const helperDir = path.join(dir, "prebuilds", "darwin-arm64");
    mkdirSync(helperDir, { recursive: true });
    const helper = path.join(helperDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\necho ok\n");
    chmodSync(helper, 0o755);

    expect(ensureNodePtySpawnHelpersExecutable(dir)).toEqual([]);
  });

  it("is a no-op when the package root has no helpers", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pty-helper-empty-"));
    expect(ensureNodePtySpawnHelpersExecutable(dir)).toEqual([]);
  });
});
