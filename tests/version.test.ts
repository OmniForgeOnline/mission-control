import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  compareVersions,
  isBehind,
  parseLatestVersion,
  readPackageMeta
} from "../src/core/system/version.ts";

describe("compareVersions", () => {
  it("returns 0 for equal releases", () => {
    expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
  });

  it("returns negative when installed is behind latest", () => {
    expect(compareVersions("0.1.3", "0.1.4")).toBeLessThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when installed is ahead of latest", () => {
    expect(compareVersions("0.1.5", "0.1.4")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("compares release segments numerically, not lexically", () => {
    // 0.10.0 must be greater than 0.9.0 (lexical compare would get this wrong).
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  it("ignores a leading v and build/prerelease metadata", () => {
    expect(compareVersions("v0.1.3", "0.1.3")).toBe(0);
    // A prerelease of the same release is lower than the release.
    expect(compareVersions("0.1.3-beta", "0.1.3")).toBeLessThan(0);
    expect(compareVersions("0.1.3", "0.1.4-rc.1")).toBeLessThan(0);
  });

  it("treats fewer segments as zero-padded", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
  });
});

describe("isBehind", () => {
  it("is true only when installed is strictly older", () => {
    expect(isBehind("0.1.3", "0.1.4")).toBe(true);
    expect(isBehind("0.1.4", "0.1.4")).toBe(false);
    expect(isBehind("0.1.5", "0.1.4")).toBe(false);
  });

  it("is false when either version is missing", () => {
    expect(isBehind("", "0.1.4")).toBe(false);
    expect(isBehind("0.1.3", "")).toBe(false);
    expect(isBehind("", "")).toBe(false);
  });
});

describe("parseLatestVersion", () => {
  it("reads the version field from an npm registry /latest payload", () => {
    const body = JSON.stringify({ name: "@omniforge/mission-control", version: "0.2.0" });
    expect(parseLatestVersion(body)).toBe("0.2.0");
  });

  it("returns null for malformed or version-less payloads", () => {
    expect(parseLatestVersion("not json")).toBeNull();
    expect(parseLatestVersion(JSON.stringify({ name: "x" }))).toBeNull();
    expect(parseLatestVersion(JSON.stringify({ version: 5 }))).toBeNull();
    expect(parseLatestVersion("")).toBeNull();
  });
});

describe("readPackageMeta", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harness-version-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads name and version from a package.json", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@omniforge/mission-control", version: "0.1.3" })
    );
    await expect(readPackageMeta(dir)).resolves.toEqual({
      name: "@omniforge/mission-control",
      version: "0.1.3"
    });
  });

  it("returns null fields when package.json is absent", async () => {
    await expect(readPackageMeta(dir)).resolves.toEqual({ name: null, version: null });
  });
});
