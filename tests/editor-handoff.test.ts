import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  buildLaunchCommand,
  getEditor,
  isEditorId,
  SUPPORTED_EDITORS,
  type EditorApp
} from "../src/core/editors/registry.ts";
import { defaultEditorSpawn, launchEditorForTask, type EditorSpawner } from "../src/core/editors/launch.ts";
import { worktreePathFor } from "../src/core/worktrees/worktrees.ts";
import type { HarnessTask } from "../src/core/types.ts";

function makeTask(overrides: Partial<HarnessTask> & Pick<HarnessTask, "id">): HarnessTask {
  const now = new Date().toISOString();
  return {
    title: "Hand off worktree",
    description: "Open the ticket worktree in a desktop editor.",
    agent: "codex",
    source: "intake",
    links: [],
    targets: [],
    messages: [],
    repoPath: "/dest/repo",
    branch: "harness/example",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("editor registry", () => {
  it("ships VS Code, Cursor, Codex, and Kiro", () => {
    const ids = SUPPORTED_EDITORS.map((editor) => editor.id);
    expect(ids).toEqual(["vscode", "cursor", "codex", "kiro"]);
  });

  it("looks editors up by id and rejects unknown ids", () => {
    expect(getEditor("vscode")?.label).toBe("VS Code");
    expect(getEditor("nope")).toBeUndefined();
  });

  it("type-guards editor ids", () => {
    expect(isEditorId("cursor")).toBe(true);
    expect(isEditorId("vim")).toBe(false);
    expect(isEditorId(undefined)).toBe(false);
  });
});

describe("buildLaunchCommand", () => {
  const vscode = getEditor("vscode")!;

  it("launches the desktop app by name on macOS", () => {
    const cmd = buildLaunchCommand(vscode, "darwin", "/wt");
    expect(cmd.command).toBe("open");
    expect(cmd.args).toEqual(["-a", vscode.darwinAppName, "/wt"]);
  });

  it("launches Codex through its `codex app <path>` workspace subcommand on macOS", () => {
    // Codex's running desktop app ignores the folder argument of `open -a`, so the
    // workspace must be opened via its subcommand instead. Asserting both the command
    // and that it is not the generic opener guards against regressing to `open -a`.
    const codex = getEditor("codex")!;
    const cmd = buildLaunchCommand(codex, "darwin", "/wt");
    expect(cmd.command).toBe("codex");
    expect(cmd.args).toEqual(["app", "/wt"]);
  });

  it("falls back to the editor CLI on Windows", () => {
    const cmd = buildLaunchCommand(vscode, "win32", "/wt");
    expect(cmd.command).toBe("code");
    expect(cmd.args).toEqual(["/wt"]);
  });

  it("throws when an editor has no launch strategy for the platform", () => {
    const headless: EditorApp = { id: "vscode", label: "VS Code", darwinAppName: "Visual Studio Code" };
    expect(() => buildLaunchCommand(headless, "linux", "/wt")).toThrow("not supported on linux");
  });

  it("does not hand Codex off to its terminal agent CLI off macOS", () => {
    // `codex` off macOS is the terminal agent, not a desktop-app launcher, so it must
    // never be exposed as a launch strategy. Running it detached with ignored stdio
    // would report success without opening a usable editor.
    const codex = getEditor("codex")!;
    expect(() => buildLaunchCommand(codex, "linux", "/wt")).toThrow("not supported on linux");
    expect(() => buildLaunchCommand(codex, "win32", "/wt")).toThrow("not supported on win32");
  });
});

describe("defaultEditorSpawn", () => {
  // The running node binary stands in for the editor command so the
  // spawn / exit / error contract can be exercised for real without a desktop app.
  it("resolves when the editor command exits successfully", async () => {
    await expect(defaultEditorSpawn(process.execPath, ["-e", "0"])).resolves.toBeUndefined();
  });

  it("rejects when the editor command exits non-zero", async () => {
    await expect(defaultEditorSpawn(process.execPath, ["-e", "process.exit(2)"])).rejects.toThrow();
  });

  it("rejects when the editor command cannot be found", async () => {
    await expect(
      defaultEditorSpawn("harness-definitely-not-a-real-binary", [])
    ).rejects.toThrow();
  });
});

describe("launchEditorForTask", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-editors-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects unsupported editor ids", async () => {
    const task = makeTask({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    await expect(launchEditorForTask({ root, task, editorId: "emacs" })).rejects.toThrow(
      "Unsupported editor"
    );
  });

  it("rejects when no worktree exists for the ticket", async () => {
    const task = makeTask({ id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
    await expect(
      launchEditorForTask({ root, task, editorId: "vscode", spawn: vi.fn(async () => {}) })
    ).rejects.toThrow("No worktree");
  });

  it("rejects when the resolved path is a file rather than a directory", async () => {
    const task = makeTask({ id: "cccccccc-dddd-eeee-ffff-000000000000" });
    const worktree = worktreePathFor(root, task);
    await mkdir(path.dirname(worktree), { recursive: true });
    await writeFile(worktree, "not a dir", "utf8");
    await expect(
      launchEditorForTask({ root, task, editorId: "vscode", spawn: vi.fn(async () => {}) })
    ).rejects.toThrow("No worktree");
  });

  it("launches the desktop editor at the harness-resolved worktree path", async () => {
    const task = makeTask({ id: "dddddddd-eeee-ffff-0000-111111111111" });
    const worktree = worktreePathFor(root, task);
    await mkdir(worktree, { recursive: true });

    const spawn = vi.fn<EditorSpawner>(async () => {});
    const result = await launchEditorForTask({ root, task, editorId: "cursor", platform: "darwin", spawn });

    expect(result.editorId).toBe("cursor");
    expect(result.worktreePath).toBe(worktree);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0]!;
    expect(command).toBe("open");
    expect(args).toEqual(["-a", "Cursor", worktree]);
  });

  it("surfaces a dispatch failure so the route can return a 409", async () => {
    const task = makeTask({ id: "eeeeeeee-ffff-0000-1111-222222222222" });
    const worktree = worktreePathFor(root, task);
    await mkdir(worktree, { recursive: true });
    const spawn = vi.fn(async () => {
      throw new Error("Could not launch editor: boom");
    });
    await expect(launchEditorForTask({ root, task, editorId: "vscode", spawn })).rejects.toThrow(
      "Could not launch editor"
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("editor handoff route", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-editors-api-"));
    await ensureHarnessRepository(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes supported editors in /api/state", async () => {
    const app = createServer({ root, testMode: true });
    const res = await request(app).get("/api/state").expect(200);
    const ids = (res.body.editors as Array<{ id: string }>).map((editor) => editor.id);
    expect(ids).toEqual(["vscode", "cursor", "codex", "kiro"]);
  });

  it("rejects an unknown editor id", async () => {
    const app = createServer({ root, testMode: true });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "T", description: "d", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await request(app)
      .post(`/api/tasks/${task.body.id}/open-in-editor`)
      .send({ editor: "vim" })
      .expect(400);
  });

  it("returns 404 for an unknown task", async () => {
    const app = createServer({ root, testMode: true });
    await request(app)
      .post("/api/tasks/missing/open-in-editor")
      .send({ editor: "vscode" })
      .expect(404);
  });

  it("launches the editor and reports ok when the worktree exists", async () => {
    const spawn = vi.fn(async () => {});
    const app = createServer({ root, testMode: true, editorSpawner: spawn });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "T", description: "d", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await mkdir(worktreePathFor(root, task.body), { recursive: true });

    const res = await request(app)
      .post(`/api/tasks/${task.body.id}/open-in-editor`)
      .send({ editor: "vscode" })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.editor).toBe("vscode");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the ticket has no worktree on disk", async () => {
    const spawn = vi.fn(async () => {});
    const app = createServer({ root, testMode: true, editorSpawner: spawn });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "T", description: "d", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await request(app)
      .post(`/api/tasks/${task.body.id}/open-in-editor`)
      .send({ editor: "vscode" })
      .expect(409);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns 409 when the editor fails to launch", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("Could not launch editor: boom");
    });
    const app = createServer({ root, testMode: true, editorSpawner: spawn });
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "T", description: "d", agent: "codex", source: "manual", links: [] })
      .expect(201);

    await mkdir(worktreePathFor(root, task.body), { recursive: true });

    const res = await request(app)
      .post(`/api/tasks/${task.body.id}/open-in-editor`)
      .send({ editor: "vscode" })
      .expect(409);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
