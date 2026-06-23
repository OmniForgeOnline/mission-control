import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  bindIssueTask,
  indexLocalRepos,
  parseRemoteRepoRef
} from "../src/connectors/repo-bind.ts";

const execFileAsync = promisify(execFile);

describe("repo bind", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-repo-bind-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses github and gitlab remote urls", () => {
    expect(parseRemoteRepoRef("git@github.com:octocat/hello-world.git")).toEqual({
      host: "github.com",
      slug: "octocat/hello-world"
    });
    expect(parseRemoteRepoRef("https://gitlab.com/group/project.git")).toEqual({
      host: "gitlab.com",
      slug: "group/project"
    });
  });

  it("indexes local clones and binds imported issues to targets", async () => {
    const repoDir = path.join(root, "hello-world");
    await execFileAsync("git", ["init", repoDir]);
    await execFileAsync("git", ["remote", "add", "origin", "git@gitlab.com:group/hello-world.git"], {
      cwd: repoDir
    });

    const index = await indexLocalRepos(root);
    const bound = bindIssueTask({
      title: "GitLab group/hello-world #1: Fix bug",
      issueUrl: "https://gitlab.com/group/hello-world/-/issues/1",
      source: "gitlab",
      host: "gitlab.com",
      slug: "group/hello-world",
      projectsRoot: root,
      repoIndex: index
    });

    expect(bound.targets).toHaveLength(1);
    expect(bound.targets[0]?.path).toBe(repoDir);
    expect(bound.description).toContain(repoDir);
  });
});