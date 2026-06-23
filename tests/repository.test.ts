import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTask, listTasks } from "../src/core/tasks/tasks.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { loadKernelText, loadSkillsIndex } from "../src/core/catalog/kernel.ts";

describe("harness repository", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-repo-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("initializes canonical folders and default kernel files", async () => {
    await ensureHarnessRepository(root);

    await expect(readFile(path.join(root, "kernel", "operating-principles.md"), "utf8")).resolves.toContain(
      "Operating Principles"
    );
    await expect(readFile(path.join(root, "data", "state", "tasks.json"), "utf8")).resolves.toBe("[]\n");
  });

  it("does not create a generated exports/ directory", async () => {
    await ensureHarnessRepository(root);
    await expect(stat(path.join(root, "exports"))).rejects.toThrow();
  });

  it("does not create a deprecated hooks/ directory", async () => {
    await ensureHarnessRepository(root);
    await expect(stat(path.join(root, "hooks"))).rejects.toThrow();
  });

  it("loads kernel text in memory for on-demand reads", async () => {
    await ensureHarnessRepository(root);
    const kernel = await loadKernelText(root);
    expect(kernel).toContain("kernel/operating-principles.md");
    expect(kernel).toContain("kernel/workflow-policy.md");
    expect(kernel).toContain("Operating Principles");
  });

  it("seeds workflow-policy escalation with distinct hooks and memory paths", async () => {
    await ensureHarnessRepository(root);
    const workflowPolicy = await readFile(path.join(root, "kernel", "workflow-policy.md"), "utf8");
    expect(workflowPolicy).toContain("propose_rule");
    expect(workflowPolicy).toContain(".harness/hooks.yml");
    expect(workflowPolicy).toContain("gbrain_propose");
    expect(workflowPolicy).not.toContain("kernel/skills/hooks/memory");
  });

  it("renders the skills inventory used by the harness-turn-loop pointer", async () => {
    await ensureHarnessRepository(root);
    const skills = await loadSkillsIndex(root);
    expect(skills).toContain("harness-turn-loop");
    expect(skills).toContain("proposal-first");
    expect(skills).toContain("pr-driven-execution");
    expect(skills).toContain("operator-handoff");
  });

  it("stores tasks in a file-backed queue without requiring a database", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Ship blog post",
      description: "Prepare and review a launch article.",
      agent: "claude",
      source: "manual",
      links: [{ label: "draft", url: "https://example.com/draft" }]
    });

    const tasks = await listTasks(root);

    expect(await taskLegacyStatus(root, task)).toBe("approved");
    expect(task.workflowRun?.workflowId).toBe("code-feature");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.links[0]?.label).toBe("draft");
  });

  it("drops stored agent messages that only contain protocol events", async () => {
    await ensureHarnessRepository(root);
    const protocolOnly = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: "/repo",
        session_id: "claude-sess",
        tools: ["Bash", "Edit"]
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-sess",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "npm run test" } }]
        }
      })
    ].join("\n");
    await writeFile(
      path.join(root, "data", "state", "tasks.json"),
      `${JSON.stringify([
        {
          id: "task-1",
          title: "Polish output",
          description: "",
          agent: "claude",
          source: "manual",
          links: [],
          targets: [],
          messages: [
            {
              id: "bad",
              author: "agent",
              body: protocolOnly,
              stepId: "implement",
              createdAt: "2026-06-20T00:00:00.000Z"
            },
            {
              id: "good",
              author: "agent",
              body: "Final answer ready.",
              stepId: "implement",
              createdAt: "2026-06-20T00:01:00.000Z"
            }
          ],
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z"
        }
      ])}\n`,
      "utf8"
    );

    const [task] = await listTasks(root);

    expect(task?.messages.map((message) => message.id)).toEqual(["good"]);
  });
});
