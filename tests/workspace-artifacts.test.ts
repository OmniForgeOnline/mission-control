import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatWorkspaceArtifactsSection,
  gatherWorkspaceArtifacts
} from "../src/core/worktrees/workspace-artifacts.ts";

describe("workspace artifacts", () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "harness-artifacts-"));
    await writeFile(
      path.join(scratchDir, "post.md"),
      "# Launch Post\n\nRead more at [docs](/docs/intro).\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it("gathers markdown links, headings, and excerpts from scratch workspaces", async () => {
    const artifacts = await gatherWorkspaceArtifacts({
      cwd: scratchDir,
      isRepo: false,
      created: false
    });

    expect(artifacts.files).toContain("post.md");
    expect(artifacts.markdownLinks).toContain("/docs/intro");
    expect(artifacts.headings).toContain("Launch Post");
    expect(artifacts.fileExcerpts).toContain("Launch Post");

    const section = formatWorkspaceArtifactsSection(artifacts);
    expect(section).toContain("Workspace artifacts (gathered programmatically)");
    expect(section).toContain("/docs/intro");
  });
});