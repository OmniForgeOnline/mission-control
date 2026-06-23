import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendVisualReviewSection,
  buildScreenshotRawUrl,
  buildVisualReviewSection,
  detectCommittedScreenshots,
  isScreenshotArtifact,
  isUiInvolvedWorkflow,
  VISUAL_REVIEW_HEADING
} from "../src/core/merge-request/screenshots.ts";
import type { RemoteRepoIdentity } from "../src/core/merge-request/types.ts";

const GITHUB: RemoteRepoIdentity = { host: "github.com", slug: "octocat/hello-world" };
const GITLAB: RemoteRepoIdentity = { host: "gitlab.com", slug: "group/project" };

async function initRepo(repoDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init"], { cwd: repoDir });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
  await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
}

describe("merge request screenshot detection", () => {
  describe("isUiInvolvedWorkflow", () => {
    it("treats frontend-ui-change as UI-involved", () => {
      expect(isUiInvolvedWorkflow("frontend-ui-change")).toBe(true);
    });

    it("leaves non-UI workflows unaffected", () => {
      expect(isUiInvolvedWorkflow("code-feature")).toBe(false);
      expect(isUiInvolvedWorkflow("bugfix")).toBe(false);
      expect(isUiInvolvedWorkflow(undefined)).toBe(false);
      expect(isUiInvolvedWorkflow(null)).toBe(false);
    });
  });

  describe("isScreenshotArtifact", () => {
    it("matches committed images under a screenshots path segment", () => {
      expect(isScreenshotArtifact("screenshots/before.png")).toBe(true);
      expect(isScreenshotArtifact("docs/screenshots/login.png")).toBe(true);
      expect(isScreenshotArtifact("src/features/x/screenshots/modal.jpeg")).toBe(true);
      expect(isScreenshotArtifact("screenshots/recording.webp")).toBe(true);
      expect(isScreenshotArtifact("screenshots/interaction.gif")).toBe(true);
    });

    it("rejects unrelated assets and non-image files even when named screenshot", () => {
      expect(isScreenshotArtifact("assets/hero.png")).toBe(false);
      expect(isScreenshotArtifact("public/icon.svg")).toBe(false);
      expect(isScreenshotArtifact("screenshots/notes.md")).toBe(false);
      expect(isScreenshotArtifact("src/screenshot.ts")).toBe(false);
      expect(isScreenshotArtifact("README.md")).toBe(false);
    });
  });

  describe("detectCommittedScreenshots", () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-shots-"));
      await initRepo(repoDir);
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it("lists only committed screenshot artifacts introduced on the branch", async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["checkout", "-b", "harness/ui"], { cwd: repoDir });
      await mkdir(path.join(repoDir, "screenshots"), { recursive: true });
      await mkdir(path.join(repoDir, "assets"), { recursive: true });
      await writeFile(path.join(repoDir, "screenshots", "before.png"), "png-bytes");
      await writeFile(path.join(repoDir, "screenshots", "after.png"), "png-bytes");
      await writeFile(path.join(repoDir, "assets", "hero.png"), "png-bytes");
      await exec("git", ["add", "-A"], { cwd: repoDir });
      await exec("git", ["commit", "-m", "UI change with screenshots"], { cwd: repoDir });

      const shots = await detectCommittedScreenshots(repoDir, "main");
      expect(shots).toEqual(["screenshots/after.png", "screenshots/before.png"]);
    });

    it("ignores uncommitted screenshots", async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["checkout", "-b", "harness/ui"], { cwd: repoDir });
      await mkdir(path.join(repoDir, "screenshots"), { recursive: true });
      await writeFile(path.join(repoDir, "screenshots", "draft.png"), "png-bytes");
      // intentionally not staged/committed

      const shots = await detectCommittedScreenshots(repoDir, "main");
      expect(shots).toEqual([]);
    });

    it("returns an empty list for a non-repo cwd without throwing", async () => {
      const elsewhere = await mkdtemp(path.join(tmpdir(), "harness-mr-shots-norepo-"));
      try {
        const shots = await detectCommittedScreenshots(elsewhere, "main");
        expect(shots).toEqual([]);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  describe("buildScreenshotRawUrl", () => {
    it("builds a github raw url that preserves branch slashes", () => {
      expect(buildScreenshotRawUrl(GITHUB, "harness/ui-change", "screenshots/before.png")).toBe(
        "https://github.com/octocat/hello-world/raw/harness/ui-change/screenshots/before.png"
      );
    });

    it("builds a gitlab raw url with the raw path segment", () => {
      expect(buildScreenshotRawUrl(GITLAB, "main", "screenshots/before.png")).toBe(
        "https://gitlab.com/group/project/-/raw/main/screenshots/before.png"
      );
    });

    it("encodes spaces and special characters per path segment", () => {
      expect(buildScreenshotRawUrl(GITHUB, "feature/x", "screenshots/before after.png")).toBe(
        "https://github.com/octocat/hello-world/raw/feature/x/screenshots/before%20after.png"
      );
    });
  });

  describe("buildVisualReviewSection", () => {
    it("renders an image embed per screenshot under the heading", () => {
      const section = buildVisualReviewSection(GITHUB, "harness/ui", [
        "screenshots/before.png",
        "screenshots/after.png"
      ]);
      expect(section.startsWith(VISUAL_REVIEW_HEADING)).toBe(true);
      expect(section).toContain(
        "![UI change: screenshots/before.png](https://github.com/octocat/hello-world/raw/harness/ui/screenshots/before.png)"
      );
      expect(section).toContain(
        "![UI change: screenshots/after.png](https://github.com/octocat/hello-world/raw/harness/ui/screenshots/after.png)"
      );
    });

    it("returns an empty section when there are no screenshots", () => {
      expect(buildVisualReviewSection(GITHUB, "harness/ui", [])).toBe("");
    });
  });

  describe("appendVisualReviewSection", () => {
    it("appends the section after the existing description", () => {
      const description = "## Overview\n\nBody.\n\n## Impact\n\nReal effect.";
      const result = appendVisualReviewSection(description, `${VISUAL_REVIEW_HEADING}\n\n![x](y)`);
      expect(result).toBe(`${description}\n\n${VISUAL_REVIEW_HEADING}\n\n![x](y)`);
    });

    it("leaves the description untouched for an empty section", () => {
      const description = "## Overview\n\nBody.";
      expect(appendVisualReviewSection(description, "")).toBe(description);
    });
  });
});
