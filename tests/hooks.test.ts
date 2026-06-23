import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listHooks, runHooks } from "../src/core/review/hooks.ts";

describe("hooks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-hooks-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeHooksFile(content: string): Promise<void> {
    const dir = path.join(root, ".harness");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(path.join(dir, "hooks.yml"), content, "utf8");
  }

  // ---------------------------------------------------------------------------
  // YAML parsing
  // ---------------------------------------------------------------------------

  it("returns empty array when no hooks file exists", async () => {
    const hooks = await listHooks(root);
    expect(hooks).toEqual([]);
  });

  it("parses a single hook from hooks.yml", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: notify-slack
`);
    const hooks = await listHooks(root);
    expect(hooks).toEqual([{ event: "on_blocked", command: "notify-slack" }]);
  });

  it("parses multiple hooks with optional fields", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: notify-slack
  - event: on_file_change
    pattern: "*.py"
    command: ruff check
    timeout: 30
`);
    const hooks = await listHooks(root);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual({ event: "on_blocked", command: "notify-slack" });
    expect(hooks[1]).toEqual({ event: "on_file_change", pattern: "*.py", command: "ruff check", timeout: 30 });
  });

  it("ignores invalid event names", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: valid-cmd
  - event: not_a_real_event
    command: invalid-cmd
`);
    const hooks = await listHooks(root);
    expect(hooks).toEqual([{ event: "on_blocked", command: "valid-cmd" }]);
  });

  it("skips hooks missing required fields", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
  - command: missing-event
`);
    const hooks = await listHooks(root);
    expect(hooks).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // runHooks execution
  // ---------------------------------------------------------------------------

  it("returns undefined when no hooks match the event", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: echo hello
`);
    const result = await runHooks(root, "on_turn_start", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when a hook exits with code 0", async () => {
    await writeHooksFile(`
hooks:
  - event: on_turn_start
    command: echo ok
`);
    const result = await runHooks(root, "on_turn_start", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeUndefined();
  });

  it("returns HookBlock when a hook exits with code 2", async () => {
    await writeHooksFile(`
hooks:
  - event: on_turn_start
    command: echo "Security violation detected" >&2 && exit 2
`);
    const result = await runHooks(root, "on_turn_start", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("Security violation detected");
    expect(result!.command).toContain("exit 2");
  });

  it("continues past hooks that exit with non-zero non-2 codes", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: exit 1
  - event: on_blocked
    command: echo second-ran
`);
    const result = await runHooks(root, "on_blocked", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      blockedReason: "test",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeUndefined(); // Neither exited 2
  });

  it("stops the chain on exit code 2", async () => {
    await writeHooksFile(`
hooks:
  - event: on_turn_start
    command: exit 2
  - event: on_turn_start
    command: echo "should not run"
`);
    const result = await runHooks(root, "on_turn_start", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeDefined();
  });

  it("pipes JSON context to the hook via stdin", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: cat > ${root}/hook-stdin.json
`);
    const result = await runHooks(root, "on_blocked", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      blockedReason: "test reason",
      workspace: { cwd: root, isRepo: false }
    });
    expect(result).toBeUndefined();
    const { readFile } = await import("node:fs/promises");
    const received = JSON.parse(await readFile(path.join(root, "hook-stdin.json"), "utf8"));
    expect(received.blockedReason).toBe("test reason");
    expect(received.runId).toBe("r1");
  });

  it("times out hooks that run too long", async () => {
    await writeHooksFile(`
hooks:
  - event: on_blocked
    command: sleep 60
    timeout: 1
`);
    const start = Date.now();
    const result = await runHooks(root, "on_blocked", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      blockedReason: "test",
      workspace: { cwd: root, isRepo: false }
    });
    const elapsed = Date.now() - start;
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(5000); // Should have timed out within ~1s
  }, 10000);

  // ---------------------------------------------------------------------------
  // Pattern matching for on_file_change
  // ---------------------------------------------------------------------------

  it("filters on_file_change hooks by pattern", async () => {
    await writeHooksFile(`
hooks:
  - event: on_file_change
    pattern: "*.py"
    command: ruff check
  - event: on_file_change
    pattern: "*.ts"
    command: tsc --noEmit
`);
    // Only the *.ts hook should fire for .ts files.
    const result = await runHooks(root, "on_file_change", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      changedFiles: ["src/index.ts", "src/utils.ts"],
      workspace: { cwd: root, isRepo: false }
    });
    // Both match, neither exits 2, so undefined.
    expect(result).toBeUndefined();
  });

  it("skips on_file_change hooks whose pattern does not match any file", async () => {
    await writeHooksFile(`
hooks:
  - event: on_file_change
    pattern: "*.py"
    command: exit 2
`);
    const result = await runHooks(root, "on_file_change", {
      task: { id: "t1", title: "Test", description: "desc", agent: "claude" },
      runId: "r1",
      changedFiles: ["src/index.ts"],
      workspace: { cwd: root, isRepo: false }
    });
    // Pattern *.py doesn't match .ts files, so hook doesn't fire.
    expect(result).toBeUndefined();
  });
});
