import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { completeTargets } from "../src/core/paths/targets.ts";
import { createServer } from "../src/server/app.ts";

describe("@ target autocomplete", () => {
  let homeRoot: string;
  let harnessRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(path.join(tmpdir(), "harness-complete-"));
    harnessRoot = path.join(homeRoot, "codex", "harness");
    await mkdir(path.join(harnessRoot, "src", "ui", "components"), { recursive: true });
    await writeFile(
      path.join(harnessRoot, "src", "ui", "components", "Button.tsx"),
      "export {}\n",
      "utf8"
    );
    await mkdir(path.join(homeRoot, "repos", "omniforge", "front-end", "apps", "product-site"), {
      recursive: true
    });
    await mkdir(path.join(homeRoot, "repos", "omniforge", "omniforge-app", "backend", "app"), {
      recursive: true
    });
    await writeFile(
      path.join(homeRoot, "repos", "omniforge", "omniforge-app", "backend", "app", "main.py"),
      "print('app')\n",
      "utf8"
    );
    await mkdir(path.join(homeRoot, "repos", "other", "backend", "app"), { recursive: true });
    await writeFile(
      path.join(homeRoot, "repos", "other", "backend", "app", "main.py"),
      "print('other')\n",
      "utf8"
    );
    await mkdir(path.join(homeRoot, "repos", "other"), { recursive: true });
    await writeFile(path.join(homeRoot, "repos", "README.md"), "# repos\n", "utf8");
  });

  afterEach(async () => {
    await rm(homeRoot, { recursive: true, force: true });
  });

  it("returns filesystem suggestions for @-prefixed paths under the home root", async () => {
    const results = await completeTargets(`@${path.join(homeRoot, "repos", "om")}`, { homeRoot });

    expect(results).toEqual([
      {
        label: "omniforge/",
        path: path.join(homeRoot, "repos", "omniforge"),
        kind: "directory",
        insertText: `@${path.join(homeRoot, "repos", "omniforge")}`
      }
    ]);
  });

  it("completes bare @ and home-relative @ prefixes from the home root", async () => {
    expect((await completeTargets("@", { homeRoot })).map((item) => item.label)).toContain("repos/");

    const results = await completeTargets("@re", { homeRoot });

    expect(results).toContainEqual({
      label: "repos/",
      path: path.join(homeRoot, "repos"),
      kind: "directory",
      insertText: `@${path.join(homeRoot, "repos")}`
    });
  });

  it("completes nested home-relative @ prefixes", async () => {
    const results = await completeTargets("@repos/om", { homeRoot });

    expect(results).toEqual([
      {
        label: "omniforge/",
        path: path.join(homeRoot, "repos", "omniforge"),
        kind: "directory",
        insertText: `@${path.join(homeRoot, "repos", "omniforge")}`
      }
    ]);
  });

  it("finds matching descendants when a bare term is not an immediate path segment", async () => {
    const results = await completeTargets("@harness", { homeRoot });

    expect(results).toContainEqual({
      label: "harness/",
      path: harnessRoot,
      kind: "directory",
      insertText: `@${harnessRoot}`
    });
  });

  it("finds nested paths via substring match without typing from root", async () => {
    const results = await completeTargets("@components", { homeRoot });

    expect(results).toContainEqual({
      label: "components/",
      path: path.join(harnessRoot, "src", "ui", "components"),
      kind: "directory",
      insertText: `@${path.join(harnessRoot, "src", "ui", "components")}`
    });
    expect(results).toContainEqual({
      label: "Button.tsx",
      path: path.join(harnessRoot, "src", "ui", "components", "Button.tsx"),
      kind: "file",
      insertText: `@${path.join(harnessRoot, "src", "ui", "components", "Button.tsx")}`
    });
  });

  it("finds deeply nested directories by basename without typing the full path", async () => {
    const projectsRoot = path.join(homeRoot, "repos");
    const productSite = path.join(projectsRoot, "omniforge", "front-end", "apps", "product-site");
    const results = await completeTargets("@product-site", { homeRoot: projectsRoot });

    expect(results[0]).toEqual({
      label: "product-site/",
      path: productSite,
      kind: "directory",
      insertText: `@${productSite}`
    });
  });

  it("finds deeply nested files by path suffix without typing from the root", async () => {
    const appMain = path.join(homeRoot, "repos", "omniforge", "omniforge-app", "backend", "app", "main.py");
    const results = await completeTargets("@backend/app/main.py", { homeRoot });

    expect(results).toContainEqual({
      label: "main.py",
      path: appMain,
      kind: "file",
      insertText: `@${appMain}`
    });
  });

  it("finds all deeply nested files by basename without typing the folder path", async () => {
    const appMain = path.join(homeRoot, "repos", "omniforge", "omniforge-app", "backend", "app", "main.py");
    const otherMain = path.join(homeRoot, "repos", "other", "backend", "app", "main.py");
    const results = await completeTargets("@main.py", { homeRoot });
    const resultPaths = results.map((item) => item.path);

    expect(resultPaths).toContain(appMain);
    expect(resultPaths).toContain(otherMain);
  });

  it("prefers recently used historical paths when substring matches", async () => {
    const historicalPath = path.join(harnessRoot, "src", "ui", "components", "Button.tsx");
    const tasksPath = path.join(harnessRoot, "data", "state");
    await mkdir(tasksPath, { recursive: true });
    await writeFile(
      path.join(tasksPath, "tasks.json"),
      JSON.stringify([
        {
          id: "task-1",
          title: "Older task",
          description: `Touch ${historicalPath}`,
          targets: [{ raw: `@${historicalPath}`, path: historicalPath, kind: "file" }],
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "task-2",
          title: "Recent task",
          description: `Work in @${historicalPath}`,
          targets: [],
          updatedAt: "2026-06-01T00:00:00.000Z"
        }
      ]),
      "utf8"
    );

    const results = await completeTargets("@Button", {
      homeRoot,
      harnessRoot
    });

    expect(results[0]).toEqual({
      label: "Button.tsx",
      path: historicalPath,
      kind: "file",
      insertText: `@${historicalPath}`
    });
  });

  it("exposes target completions through the API", async () => {
    const app = createServer({ root: harnessRoot, homeRoot });

    const result = await request(app)
      .get("/api/targets/complete")
      .query({ prefix: `@${path.join(homeRoot, "repos", "o")}` })
      .expect(200);

    expect(result.body.map((item: { label: string }) => item.label)).toEqual(["omniforge/", "other/"]);
  });
});
