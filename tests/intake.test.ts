import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import {
  addIntakeMessage,
  confirmIntakeDraft,
  drainIntakeQueue,
  getIntakeSession,
  parseIntakeReply,
  repairJsonStringLiterals,
  resetIntakeSession,
  retryIntakeQueueItem,
  runIntakeTurn
} from "../src/core/intake/intake.ts";
import { buildIntakePrompt } from "../src/core/intake/prompts.ts";
import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { saveUploadedAttachment } from "../src/core/attachments/store.ts";
import { onboardProject } from "../src/core/projects/registry.ts";
import { listTasks } from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";
import type { ToolId } from "../src/core/types.ts";

function intakeJson(reply: string, ticket: Record<string, unknown>): string {
  return JSON.stringify({ reply, ticket });
}

const globalScope = { kind: "global" as const };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Budget must absorb full-suite disk/CPU contention: each checkpoint gates a
// chain of ~10 blocking file reads/writes in the serialized intake drain.
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await delay(10);
    last = await read();
  }
  expect(predicate(last)).toBe(true);
  return last;
}

class DeferredAgentRunner implements AgentRunner {
  agent: ToolId = "claude";
  requests: AgentTurnRequest[] = [];
  aborted = 0;
  private resolvers: Array<(result: AgentTurnResult) => void> = [];

  abort(): void {
    this.aborted++;
    this.resolvers.shift();
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.requests.push(request);
    request.onActivity?.({ label: "classifying request", at: new Date().toISOString() });
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  resolveNext(reply: string, exitCode = 0): void {
    const resolver = this.resolvers.shift();
    if (!resolver) throw new Error("No pending runner request.");
    resolver({
      reply,
      sessionId: "deferred-session",
      exitCode,
      command: "deferred",
      rawLog: reply,
      ...(exitCode === 0 ? {} : { blockedReason: "deferred failure" })
    });
  }
}

describe("intake", () => {
  let rootBase: string;
  let root: string;

  beforeEach(async () => {
    rootBase = await mkdtemp(path.join(tmpdir(), "harness-intake-"));
    root = path.join(rootBase, "codex", "harness");
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(rootBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("parses structured intake replies", () => {
    const parsed = parseIntakeReply(
      intakeJson("This looks like a bugfix.", {
        ready: true,
        title: "Fix API 500",
        description: "Reproduce and patch empty payload handling.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "User reports a crash with clear repro.",
        suggestNewWorkflow: null
      })
    );
    expect(parsed.draft?.ready).toBe(true);
    expect(parsed.draft?.workflowId).toBe("bugfix");
    expect(parsed.reply).toContain("bugfix");
  });

  it("still parses legacy proposal blocks from older agent replies", () => {
    const parsed = parseIntakeReply(`
\`\`\`json
{
  "reply": "Legacy format.",
  "proposal": {
    "ready": true,
    "title": "Fix API 500",
    "description": "Patch empty payload handling.",
    "workflowId": "bugfix",
    "confidence": "high",
    "rationale": "Clear defect.",
    "proposeNewWorkflow": null
  }
}
\`\`\`
`);
    expect(parsed.draft?.ready).toBe(true);
    expect(parsed.draft?.workflowId).toBe("bugfix");
  });

  it("creates an active intake session", async () => {
    const session = await getIntakeSession(root);
    expect(session.agent).toBe("grok");
    expect(session.status).toBe("active");
    expect(session.scope).toEqual(globalScope);
    expect(session.messages).toEqual([]);
  });

  it("scoped intake keeps global and project sessions independent", async () => {
    await addIntakeMessage(root, { author: "operator", body: "Global task." });
    await addIntakeMessage(
      root,
      { author: "operator", body: "Project task." },
      { kind: "project", projectId: "proj-test" }
    );

    const globalSession = await getIntakeSession(root);
    const projectSession = await getIntakeSession(root, { kind: "project", projectId: "proj-test" });

    expect(globalSession.scope).toEqual(globalScope);
    expect(projectSession.scope).toEqual({ kind: "project", projectId: "proj-test" });
    expect(globalSession.messages.map((message) => message.body)).toEqual(["Global task."]);
    expect(projectSession.messages.map((message) => message.body)).toEqual(["Project task."]);
  });

  it("migrates the legacy intake session file into the global scoped session", async () => {
    const legacyPath = path.join(root, "data", "state", "intake-session.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        id: "legacy-session",
        agent: "grok",
        status: "active",
        messages: [{ id: "m1", author: "operator", body: "Legacy message.", createdAt: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    );

    const session = await getIntakeSession(root);

    expect(session.scope).toEqual(globalScope);
    expect(session.messages[0]?.body).toBe("Legacy message.");
  });

  it("creates a ticket immediately when intake is ready", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("I'll route this as a code feature.", {
        ready: true,
        title: "Add workflow intake",
        description: "Build chat-based ticket intake on the harness home page.",
        workflowId: "code-feature",
        confidence: "high",
        rationale: "Greenfield engineering feature.",
        suggestNewWorkflow: null
      })
    ]);

    await addIntakeMessage(root, { author: "operator", body: "Build chat intake on the home page." });
    const result = await runIntakeTurn(root, { runner });
    expect(result.task?.title).toBe("Add workflow intake");
    expect(result.task?.workflowRun?.workflowId).toBe("code-feature");
    expect(result.task?.source).toBe("intake");
    expect(result.task?.projectId).toBeUndefined();

    const session = await getIntakeSession(root);
    expect(session.messages).toEqual([]);
  });

  it("runs the intake classifier in non-planning classify mode", async () => {
    const modes: Array<AgentTurnRequest["mode"]> = [];
    const runner: AgentRunner = {
      agent: "claude",
      abort() {},
      async runTurn(request) {
        modes.push(request.mode);
        return {
          reply: intakeJson("Filed as a code feature.", {
            ready: true,
            title: "Add login button",
            description: "Add a login button to the auth screen.",
            workflowId: "code-feature",
            confidence: "high",
            rationale: "Greenfield feature request.",
            suggestNewWorkflow: null
          }),
          sessionId: "classify-session",
          exitCode: 0,
          command: "classify",
          rawLog: ""
        };
      }
    };

    await addIntakeMessage(root, { author: "operator", body: "Add a login button." });
    await runIntakeTurn(root, { runner });

    expect(modes).toContain("classify");
    expect(modes).not.toContain("plan");
  });

  it("retries when the agent returns invalid output then succeeds", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "Here is my answer without JSON.",
      intakeJson("Second try worked.", {
        ready: true,
        title: "Fix login",
        description: "Patch redirect loop.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect.",
        suggestNewWorkflow: null
      })
    ]);

    await addIntakeMessage(root, { author: "operator", body: "Users cannot log in." });
    const result = await runIntakeTurn(root, { runner });

    expect(result.task?.title).toBe("Fix login");
    expect((await getIntakeSession(root)).messages).toEqual([]);
  });

  it("retries a failed intake item in place and reclassifies it", async () => {
    const repoDir = path.join(rootBase, "repos", "retry-project");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir });
    const project = await onboardProject(root, { repoPath: repoDir, name: "Retry Project" });
    const runner = new DeferredAgentRunner();
    const app = createServer({ root, runner });

    await request(app).post(`/api/projects/${project.id}/intake/messages`).send({ body: "Fix the bug." }).expect(202);

    // Drive classification to failure: three invalid replies exhaust the retries.
    await waitFor(async () => runner.requests.length, (value) => value === 1);
    runner.resolveNext("no json here");
    await waitFor(async () => runner.requests.length, (value) => value === 2);
    runner.resolveNext("still no json");
    await waitFor(async () => runner.requests.length, (value) => value === 3);
    runner.resolveNext("nothing valid");

    const failed = await waitFor(
      () => getIntakeSession(root, { kind: "project", projectId: project.id }),
      (value) => value.queue?.[0]?.status === "failed"
    );
    expect(failed.queue?.[0]?.error).toContain("invalid output");
    const failedItemId = failed.queue?.[0]?.id;
    expect(failedItemId).toBeTruthy();

    // Retry the failed item in place (no duplicate message).
    await request(app)
      .post(`/api/projects/${project.id}/intake/queue/${failedItemId}/retry`)
      .send({})
      .expect(200);

    // The retry re-drains the same item; supply a valid reply.
    await waitFor(async () => runner.requests.length, (value) => value === 4);
    runner.resolveNext(
      intakeJson("Filed on retry.", {
        ready: true,
        title: "Fix the bug",
        description: "Patch the bug surfaced on retry.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect.",
        suggestNewWorkflow: null
      })
    );

    const completed = await waitFor(
      () => getIntakeSession(root, { kind: "project", projectId: project.id }),
      (value) => value.queue?.[0]?.status === "completed"
    );
    expect(completed.queue?.[0]?.taskId).toBeTruthy();
  });

  it("rejects retrying an intake item that is not failed", async () => {
    const repoDir = path.join(rootBase, "repos", "retry-guard-project");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir });
    const project = await onboardProject(root, { repoPath: repoDir, name: "Retry Guard Project" });
    const scope = { kind: "project" as const, projectId: project.id };
    await addIntakeMessage(root, { author: "operator", body: "Hello" }, scope);
    const session = await getIntakeSession(root, scope);
    const itemId = session.queue?.[0]?.id;
    expect(itemId).toBeTruthy();

    await expect(retryIntakeQueueItem(root, scope, itemId!)).rejects.toThrow(/failed/i);
  });

  it("creates a ticket from a ready intake draft", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("Opening ticket.", {
        ready: true,
        title: "Write launch memo",
        description: "Draft an internal launch memo.",
        workflowId: "write-document",
        confidence: "high",
        rationale: "Documentation request.",
        suggestNewWorkflow: null
      })
    ]);
    await addIntakeMessage(root, { author: "operator", body: "Write a launch memo." });
    const result = await runIntakeTurn(root, { runner });

    expect(result.task?.workflowRun?.workflowId).toBe("write-document");
    expect(result.task?.source).toBe("intake");
    expect((await listTasks(root)).some((task) => task.id === result.task?.id)).toBe(true);

    const fresh = await getIntakeSession(root);
    expect(fresh.status).toBe("active");
    expect(fresh.messages).toEqual([]);
  });

  it("keeps chatting when no bundled workflow fits yet", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("No bundled workflow fits well. I suggested legal-review in chat.", {
        ready: false,
        title: "",
        description: "",
        workflowId: null,
        confidence: "low",
        rationale: "Needs a legal-review workflow.",
        suggestNewWorkflow: {
          suggestedId: "legal-review",
          suggestedName: "Legal Review",
          rationale: "Contract review is not covered.",
          outline: "intake → review → approval → handoff"
        }
      })
    ]);
    await addIntakeMessage(root, { author: "operator", body: "Review this vendor contract." });
    const result = await runIntakeTurn(root, { runner });
    const session = await getIntakeSession(root);
    expect(result.reply).toContain("legal-review");
    expect(session.messages.some((message) => message.author === "agent")).toBe(true);
    expect(result.task).toBeUndefined();
  });

  it("rejects global intake API submissions because tickets require a project", async () => {
    const app = createServer({ root, testMode: true });
    const message = await request(app)
      .post("/api/intake/messages")
      .send({ body: "Users cannot log in after redirect." })
      .expect(409);
    expect(message.body.error).toContain("project");
    expect(await listTasks(root)).toHaveLength(0);
  });

  it("project intake API queues and creates a project-scoped ticket", async () => {
    const repoDir = path.join(rootBase, "repos", "project-app");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir });
    const project = await onboardProject(root, { repoPath: repoDir, name: "Project App" });

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("Project ticket ready.", {
        ready: true,
        title: "Fix project bug",
        description: "Patch selected project behavior.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect in selected project.",
        suggestNewWorkflow: null
      })
    ]);
    const app = createServer({ root, runner, testMode: true });

    const message = await request(app)
      .post(`/api/projects/${project.id}/intake/messages`)
      .send({ body: "Fix the selected project bug." })
      .expect(202);
    expect(message.body.session?.scope).toEqual({ kind: "project", projectId: project.id });

    const completed = await waitFor(() => listTasks(root), (tasks) => tasks.some((task) => task.title === "Fix project bug"));
    const task = completed.find((candidate) => candidate.title === "Fix project bug");
    expect(task?.projectId).toBe(project.id);
    expect(task?.repoPath).toBe(project.repoPath);
    expect(task?.targets[0]?.path).toBe(project.repoPath);
  });

  it("project intake prompt treats the selected project as the target repository", () => {
    const prompt = buildIntakePrompt(
      {
        id: "s1",
        agent: "grok",
        status: "active",
        scope: { kind: "project", projectId: "proj-test" },
        messages: [{ id: "m1", author: "operator", body: "Fix login.", createdAt: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      [],
      {
        scope: { kind: "project", projectId: "proj-test" },
        cwd: "/repos/project-app",
        project: {
          id: "proj-test",
          name: "Project App",
          repoPath: "/repos/project-app",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      }
    );

    expect(prompt).toContain("Selected project");
    expect(prompt).toContain("Project App");
    expect(prompt).toContain("The target repository is already selected");
  });

  it("queues intake API submissions without waiting for classification", async () => {
    const repoDir = path.join(rootBase, "repos", "queued-project");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir });
    const project = await onboardProject(root, { repoPath: repoDir, name: "Queued Project" });
    const runner = new DeferredAgentRunner();
    const app = createServer({ root, runner });

    const response = await Promise.race([
      request(app).post(`/api/projects/${project.id}/intake/messages`).send({ body: "Fix queued intake." }),
      delay(1_000).then(() => "timed-out")
    ]);

    expect(response).not.toBe("timed-out");
    const session = await getIntakeSession(root, { kind: "project", projectId: project.id });
    expect(session.messages.at(-1)?.body).toBe("Fix queued intake.");
    await waitFor(async () => runner.requests.length, (value) => value === 1);

    runner.resolveNext(
      intakeJson("Queued ticket ready.", {
        ready: true,
        title: "Fix queued intake",
        description: "Patch queued intake behavior.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect.",
        suggestNewWorkflow: null
      })
    );

    const completed = await waitFor(
      () => getIntakeSession(root, { kind: "project", projectId: project.id }),
      (value) => value.queue?.[0]?.status === "completed"
    );
    expect(completed.queue?.[0]?.taskId).toBeTruthy();
    expect(completed.messages.at(-1)?.body).toBe("Opened ticket: Fix queued intake");
    expect((await listTasks(root)).some((task) => task.title === "Fix queued intake" && task.projectId === project.id)).toBe(true);
  });

  it("drains queued intake submissions sequentially", async () => {
    const repoDir = path.join(rootBase, "repos", "sequential-project");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir });
    const project = await onboardProject(root, { repoPath: repoDir, name: "Sequential Project" });
    const runner = new DeferredAgentRunner();
    const app = createServer({ root, runner });

    await request(app).post(`/api/projects/${project.id}/intake/messages`).send({ body: "First task." }).expect(202);
    await request(app).post(`/api/projects/${project.id}/intake/messages`).send({ body: "Second task." }).expect(202);

    const queued = await waitFor(
      () => getIntakeSession(root, { kind: "project", projectId: project.id }),
      (value) => value.queue?.[0]?.status === "running"
    );
    expect(queued.queue?.map((item) => item.status)).toEqual(["running", "pending"]);
    await waitFor(async () => runner.requests.length, (value) => value === 1);

    runner.resolveNext(
      intakeJson("First ready.", {
        ready: true,
        title: "First queued task",
        description: "Handle first task.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear task.",
        suggestNewWorkflow: null
      })
    );

    await waitFor(async () => runner.requests.length, (value) => value === 2);

    runner.resolveNext(
      intakeJson("Second ready.", {
        ready: true,
        title: "Second queued task",
        description: "Handle second task.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear task.",
        suggestNewWorkflow: null
      })
    );

    await waitFor(
      () => getIntakeSession(root, { kind: "project", projectId: project.id }),
      (value) => value.queue?.every((item) => item.status === "completed") === true
    );
    expect((await listTasks(root)).map((task) => task.title)).toEqual(["Second queued task", "First queued task"]);
  });

  it("times out a stuck intake classification and continues the queue", async () => {
    const runner = new DeferredAgentRunner();
    await addIntakeMessage(root, { author: "operator", body: "Stuck task." });
    await addIntakeMessage(root, { author: "operator", body: "Later task." });

    const drain = drainIntakeQueue(root, { runner, intakeTimeoutMs: 500 });
    const timedOut = await waitFor(
      () => getIntakeSession(root),
      (value) => value.queue?.[1]?.status === "running",
      2_000
    );
    await waitFor(async () => runner.requests.length, (value) => value === 2);
    expect(timedOut.queue?.[0]).toMatchObject({ status: "failed" });
    expect(timedOut.queue?.[0]?.error).toContain("timed out");
    expect(runner.aborted).toBe(1);

    runner.resolveNext(
      intakeJson("Later ready.", {
        ready: true,
        title: "Later task",
        description: "Handle later task.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear task.",
        suggestNewWorkflow: null
      })
    );

    await waitFor(() => getIntakeSession(root), (value) => value.queue?.[1]?.status === "completed");
    await drain;
    expect((await listTasks(root)).some((task) => task.title === "Later task")).toBe(true);
  });

  it("preserves explicit repository targets from queued intake messages", async () => {
    const repo = path.join(rootBase, "repos", "omniforge-app");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("Ticket ready.", {
        ready: true,
        title: "Bump llama.cpp",
        description: "Update the llama.cpp release pin.",
        workflowId: "infrastructure-change",
        confidence: "high",
        rationale: "Version bump in target repo.",
        suggestNewWorkflow: null
      })
    ]);

    await addIntakeMessage(root, {
      author: "operator",
      body: `Update llama.cpp in @${repo}.`
    });
    await drainIntakeQueue(root, { runner });

    const task = (await listTasks(root)).find((candidate) => candidate.title === "Bump llama.cpp");
    expect(task?.targets[0]?.path).toBe(repo);
  });

  it("carries earlier-turn intake attachments onto the ticket created in a later turn", async () => {
    const earlier = await saveUploadedAttachment(root, {
      filename: "screenshot.png",
      data: Buffer.from("error-trace"),
      source: "intake"
    });
    const later = await saveUploadedAttachment(root, {
      filename: "logs.txt",
      data: Buffer.from("request-logs"),
      source: "intake"
    });

    // Turn 1: operator uploads a file, but the agent still needs clarification.
    const clarify = new DeterministicAgentRunner("grok");
    clarify.setReplies([
      intakeJson("Which endpoint is returning the 500?", {
        ready: false,
        title: "",
        description: "",
        workflowId: null,
        confidence: "low",
        rationale: "Need the failing endpoint before routing.",
        suggestNewWorkflow: null
      })
    ]);
    await addIntakeMessage(root, {
      author: "operator",
      body: "Users hit a 500.",
      attachmentIds: [earlier.id]
    });
    await drainIntakeQueue(root, { runner: clarify });
    expect(await listTasks(root)).toHaveLength(0);

    // Turn 2: operator clarifies with another file; the agent opens the ticket.
    const open = new DeterministicAgentRunner("grok");
    open.setReplies([
      intakeJson("Opening a bugfix ticket.", {
        ready: true,
        title: "Fix 500 on login",
        description: "Patch the login crash.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect with repro.",
        suggestNewWorkflow: null
      })
    ]);
    await addIntakeMessage(root, {
      author: "operator",
      body: "The /login endpoint.",
      attachmentIds: [later.id]
    });
    await drainIntakeQueue(root, { runner: open });

    const task = (await listTasks(root))[0];
    expect(task?.attachments?.map((attachment) => attachment.id).sort()).toEqual(
      [earlier.id, later.id].sort()
    );
  });

  it("keeps each queued ticket's attachments isolated across independent tickets", async () => {
    const first = await saveUploadedAttachment(root, {
      filename: "first.png",
      data: Buffer.from("1"),
      source: "intake"
    });
    const second = await saveUploadedAttachment(root, {
      filename: "second.png",
      data: Buffer.from("2"),
      source: "intake"
    });

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      intakeJson("Opening the first ticket.", {
        ready: true,
        title: "First queued ticket",
        description: "Handle the first task.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear task.",
        suggestNewWorkflow: null
      }),
      intakeJson("Opening the second ticket.", {
        ready: true,
        title: "Second queued ticket",
        description: "Handle the second task.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear task.",
        suggestNewWorkflow: null
      })
    ]);

    await addIntakeMessage(root, { author: "operator", body: "First task.", attachmentIds: [first.id] });
    await addIntakeMessage(root, { author: "operator", body: "Second task.", attachmentIds: [second.id] });
    await drainIntakeQueue(root, { runner });

    const tasks = (await listTasks(root)).sort((a, b) => a.title.localeCompare(b.title));
    expect(tasks.map((task) => task.title)).toEqual(["First queued ticket", "Second queued ticket"]);
    expect(tasks[0]?.attachments?.map((attachment) => attachment.id)).toEqual([first.id]);
    expect(tasks[1]?.attachments?.map((attachment) => attachment.id)).toEqual([second.id]);
  });

  it("parses intake JSON when description strings contain raw newlines", () => {
    const parsed = parseIntakeReply(`
\`\`\`json
{
  "reply": "Ticket drafted.",
  "ticket": {
    "ready": true,
    "title": "Fix copy",
    "description": "Line one

## Section
More detail",
    "workflowId": "bugfix",
    "confidence": "high",
    "rationale": "Copy mismatch.",
    "suggestNewWorkflow": null
  }
}
\`\`\`
`);
    expect(parsed.draft?.ready).toBe(true);
    expect(parsed.draft?.title).toBe("Fix copy");
    expect(parsed.draft?.description).toContain("## Section");
    expect(repairJsonStringLiterals('{"description": "a\nb"}')).toBe('{"description": "a\\nb"}');
  });

  it("hydrates a pending draft from the last agent reply and confirms it", async () => {
    await addIntakeMessage(root, { author: "operator", body: "Fix misleading core label on quality gate sweep." });
    await addIntakeMessage(root, {
      author: "agent",
      body: intakeJson("Ready to open a bugfix ticket.", {
        ready: true,
        title: "Fix misleading core label",
        description: "Verify sweep scope and update stale copy.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Description mismatch only.",
        suggestNewWorkflow: null
      })
    });

    const session = await getIntakeSession(root);
    expect(session.pendingDraft?.ready).toBe(true);
    expect(session.pendingDraft?.title).toBe("Fix misleading core label");

    const result = await confirmIntakeDraft(root);
    expect(result.task?.title).toBe("Fix misleading core label");
    expect((await getIntakeSession(root)).messages).toEqual([]);
  });

  it("exposes intake confirm through the API", async () => {
    const app = createServer({ root, testMode: true });
    await addIntakeMessage(root, { author: "operator", body: "Fix login redirect." });
    await addIntakeMessage(root, {
      author: "agent",
      body: intakeJson("Ready.", {
        ready: true,
        title: "Fix login",
        description: "Patch redirect loop.",
        workflowId: "bugfix",
        confidence: "high",
        rationale: "Clear defect.",
        suggestNewWorkflow: null
      })
    });
    await getIntakeSession(root);

    const confirmed = await request(app).post("/api/intake/confirm").expect(201);
    expect(confirmed.body.turn.task.title).toBe("Fix login");
  });

  it("resets intake to a fresh chat", async () => {
    await addIntakeMessage(root, { author: "operator", body: "Hello" });
    const reset = await resetIntakeSession(root);
    expect(reset.messages).toEqual([]);
    expect(reset.status).toBe("active");
  });
});
