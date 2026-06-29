import { buildIntakeCorrectionPrompt, buildIntakePrompt } from "./prompts.ts";
import {
  parseAndValidateIntakeReply,
  type IntakeAgentOutput
} from "./schema.ts";
import { resolveWorkspaceFromText } from "../paths/targets.ts";
import { getProject, type ProjectRecord } from "../projects/registry.ts";
import type {
  HarnessMessage,
  HarnessTarget,
  HarnessTask,
  IntakeScope,
  IntakeQueueItem,
  IntakeSession
} from "../types.ts";
import { listWorkflowSummaries } from "../workflows/index.ts";
import type { AgentRunner } from "../../runners/types.ts";
import { createRunnerForTool } from "../../runners/index.ts";
import {
  createTaskFromDraft,
  draftFromLastAgentMessage,
  normalizeDraft,
  parseIntakeReply,
  validateDraftWorkflow
} from "./drafts.ts";
import {
  emptyIntakeSession,
  intakeScopeKey,
  intakeTimestamp,
  makeIntakeMessage,
  normalizeIntakeScope,
  readIntakeSessionFile,
  touchIntakeSession,
  updateIntakeSessionFile,
  writeIntakeSessionFile
} from "./session.ts";

async function hydratePendingDraft(root: string, session: IntakeSession): Promise<IntakeSession> {
  if (session.pendingDraft?.ready) return session;
  const draft = await draftFromLastAgentMessage(root, session.messages);
  if (draft?.ready && draft.title && draft.description) {
    return { ...session, pendingDraft: draft };
  }
  return session;
}

export async function getIntakeSession(root: string, scope?: IntakeScope): Promise<IntakeSession> {
  const normalizedScope = normalizeIntakeScope(scope);
  const existing = await readIntakeSessionFile(root, normalizedScope);
  if (existing && existing.status === "active") {
    const hydrated = await hydratePendingDraft(root, existing);
    if (hydrated.pendingDraft && !existing.pendingDraft) {
      return writeIntakeSessionFile(root, hydrated);
    }
    return hydrated;
  }
  return writeIntakeSessionFile(root, await emptyIntakeSession(root, normalizedScope));
}

export async function resetIntakeSession(root: string, scope?: IntakeScope): Promise<IntakeSession> {
  const normalizedScope = normalizeIntakeScope(scope);
  const existing = await readIntakeSessionFile(root, normalizedScope);
  if (existing && existing.status === "active") {
    await writeIntakeSessionFile(root, { ...existing, status: "archived", updatedAt: intakeTimestamp() });
  }
  return writeIntakeSessionFile(root, await emptyIntakeSession(root, normalizedScope));
}

async function updateIntakeSession(
  root: string,
  scope: IntakeScope | undefined,
  updater: (session: IntakeSession) => IntakeSession
): Promise<IntakeSession> {
  return updateIntakeSessionFile(root, scope, (session) => hydratePendingDraft(root, session), updater);
}

export async function addIntakeMessage(
  root: string,
  input: Pick<HarnessMessage, "author" | "body"> & { attachmentIds?: string[] },
  scope?: IntakeScope
): Promise<HarnessMessage> {
  const message = makeIntakeMessage(input.author, input.body);
  if (!message.body) {
    throw new Error("Message body is required.");
  }
  const attachmentIds =
    input.attachmentIds && input.attachmentIds.length > 0 ? input.attachmentIds : undefined;
  await updateIntakeSession(root, scope, (session) => ({
    ...session,
    messages: [...session.messages, message],
    ...(message.author === "operator"
      ? { queue: [...(session.queue ?? []), queueItemForMessage(message, attachmentIds)] }
      : {}),
    updatedAt: intakeTimestamp()
  }));
  return message;
}

export { repairJsonStringLiterals } from "./schema.ts";
export { parseIntakeReply };

const INTAKE_OUTPUT_MAX_ATTEMPTS = 3;
const DEFAULT_INTAKE_TIMEOUT_MS = 5 * 60 * 1000;
const activeQueueDrains = new Set<string>();

async function runValidatedIntakeAgentTurn(
  root: string,
  session: IntakeSession,
  options: RunIntakeOptions | undefined,
  workflowIds: ReadonlySet<string>,
  project?: ProjectRecord
): Promise<{ output: IntakeAgentOutput; sessionId?: string }> {
  const workspaceText = session.messages.map((message) => message.body).join("\n\n") || "harness intake";
  const workspace = project
    ? { cwd: project.repoPath, targets: projectRepoTargets(project) }
    : await resolveWorkspaceFromText(workspaceText, { fallbackRoot: root, harnessRoot: root });
  const runner = options?.runner ?? (await createRunnerForTool(root, session.agent, "author"));
  const workflows = await listWorkflowSummaries(root);
  const timestamp = intakeTimestamp();
  const stubTask: HarnessTask = {
    id: crypto.randomUUID(),
    title: "Harness intake",
    description: "Harness intake validation",
    agent: session.agent,
    source: "intake",
    links: [],
    targets: workspace.targets,
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  let lastErrors: string[] = [];
  let sessionId = session.agentSessionId;

  for (let attempt = 1; attempt <= INTAKE_OUTPUT_MAX_ATTEMPTS; attempt++) {
    const agentTurns = session.messages.filter((message) => message.author === "agent").length + attempt - 1;
    const prompt =
      attempt === 1
        ? buildIntakePrompt(session, workflows, {
          scope: session.scope,
          cwd: workspace.cwd,
          ...(project ? { project } : {})
        })
        : buildIntakeCorrectionPrompt(lastErrors);

    const result = await runAgentTurnWithTimeout(
      runner,
      {
        mode: "classify",
        task: stubTask,
        prompt,
        cwd: workspace.cwd,
        turnNumber: agentTurns + 1,
        ...(options?.onActivity ? { onActivity: options.onActivity } : {}),
        ...(options?.onSessionId ? { onSessionId: options.onSessionId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {})
      },
      options?.intakeTimeoutMs ?? DEFAULT_INTAKE_TIMEOUT_MS
    );

    sessionId = result.sessionId ?? sessionId;
    const rawReply = result.reply.trim();
    if (!rawReply) {
      lastErrors = ["Response was empty."];
      continue;
    }

    const validation = parseAndValidateIntakeReply(rawReply, workflowIds);
    if (validation.ok) {
      return { output: validation.output, ...(sessionId !== undefined ? { sessionId } : {}) };
    }

    lastErrors = validation.errors;
  }

  throw new Error(`Intake agent returned invalid output: ${lastErrors.join("; ")}`);
}

function projectRepoTargets(project: ProjectRecord): HarnessTarget[] {
  return [{ raw: `@${project.repoPath}`, path: project.repoPath, kind: "directory" }];
}

async function projectForScope(root: string, scope: IntakeScope): Promise<ProjectRecord | undefined> {
  if (scope.kind !== "project") return undefined;
  const project = await getProject(root, scope.projectId);
  if (!project) {
    throw new Error(`Project not found: ${scope.projectId}`);
  }
  if (project.status !== "active") {
    throw new Error("Project is paused.");
  }
  return project;
}

async function runAgentTurnWithTimeout(
  runner: AgentRunner,
  request: Parameters<AgentRunner["runTurn"]>[0],
  timeoutMs: number
): ReturnType<AgentRunner["runTurn"]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runner.runTurn(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          runner.abort();
          reject(new Error(`Intake classification timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface IntakeTurnResult {
  reply: string;
  task?: HarnessTask;
}

export interface RunIntakeOptions {
  runner?: AgentRunner;
  intakeTimeoutMs?: number;
  scope?: IntakeScope;
  onActivity?: Parameters<AgentRunner["runTurn"]>[0]["onActivity"];
  onSessionId?: Parameters<AgentRunner["runTurn"]>[0]["onSessionId"];
}

export async function runIntakeTurn(root: string, options?: RunIntakeOptions): Promise<IntakeTurnResult> {
  const scope = normalizeIntakeScope(options?.scope);
  const project = await projectForScope(root, scope);
  const session = await getIntakeSession(root, scope);
  if (session.status !== "active") {
    throw new Error("Intake session is not active.");
  }

  const workflowIds = new Set((await listWorkflowSummaries(root)).map((workflow) => workflow.id));
  const { output, sessionId } = await runValidatedIntakeAgentTurn(root, session, options, workflowIds, project);

  await addIntakeMessage(root, { author: "agent", body: output.reply }, scope);

  let draft = normalizeDraft(output.ticket);
  if (draft) draft = await validateDraftWorkflow(root, draft);

  if (draft?.ready && draft.title && draft.description) {
    const workspace = project
      ? undefined
      : await resolveWorkspaceFromText(session.messages.map((message) => message.body).join("\n\n"), {
        fallbackRoot: root,
        harnessRoot: root
      });
    const task = await createTaskFromDraft(root, draft, { ...(project ? { project } : {}) }, workspace?.targets);
    const archived = await readIntakeSessionFile(root, scope);
    if (archived) {
      const { pendingDraft: _draft, ...archivedWithoutDraft } = archived;
      await writeIntakeSessionFile(root, {
        ...archivedWithoutDraft,
        status: "task_created",
        createdTaskId: task.id,
        updatedAt: intakeTimestamp()
      });
    }
    await resetIntakeSession(root, scope);
    return { reply: output.reply, task };
  }

  await updateIntakeSession(root, scope, (current) => {
    const nextSessionId = sessionId ?? current.agentSessionId;
    return {
      ...current,
      ...(draft !== undefined ? { pendingDraft: draft } : {}),
      ...(nextSessionId !== undefined ? { agentSessionId: nextSessionId } : {}),
      updatedAt: intakeTimestamp()
    };
  });

  return { reply: output.reply };
}

export async function dismissIntakeDraft(root: string, scope?: IntakeScope): Promise<IntakeSession> {
  return updateIntakeSession(root, scope, (session) => {
    const { pendingDraft: _draft, ...rest } = session;
    return touchIntakeSession(rest);
  });
}

export async function confirmIntakeDraft(root: string, scope?: IntakeScope): Promise<IntakeTurnResult> {
  const normalizedScope = normalizeIntakeScope(scope);
  const project = await projectForScope(root, normalizedScope);
  const session = await getIntakeSession(root, normalizedScope);
  let draft = session.pendingDraft ?? (await draftFromLastAgentMessage(root, session.messages));
  if (!draft?.ready || !draft.title || !draft.description) {
    throw new Error("No ready intake draft to confirm.");
  }

  draft = await validateDraftWorkflow(root, draft);

  const task = await createTaskFromDraft(root, draft, { ...(project ? { project } : {}) });
  const archived = await readIntakeSessionFile(root, normalizedScope);
  if (archived) {
    const { pendingDraft: _confirmDraft, ...archivedWithoutDraft } = archived;
    await writeIntakeSessionFile(root, {
      ...archivedWithoutDraft,
      status: "task_created",
      createdTaskId: task.id,
      updatedAt: intakeTimestamp()
    });
  }
  await resetIntakeSession(root, normalizedScope);
  return { reply: `Opened ticket: ${task.title}`, task };
}

function queueItemForMessage(message: HarnessMessage, attachmentIds?: string[]): IntakeQueueItem {
  return {
    id: globalThis.crypto.randomUUID(),
    messageId: message.id,
    status: "pending",
    createdAt: intakeTimestamp(),
    ...(attachmentIds ? { attachmentIds } : {})
  };
}

async function markQueueItem(
  root: string,
  scope: IntakeScope | undefined,
  itemId: string,
  patch: Partial<IntakeQueueItem>
): Promise<IntakeSession> {
  return updateIntakeSession(root, scope, (session) => ({
    ...session,
    queue: (session.queue ?? []).map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    updatedAt: intakeTimestamp()
  }));
}

function queuedMessage(session: IntakeSession, item: IntakeQueueItem): HarnessMessage | undefined {
  return session.messages.find((message) => message.id === item.messageId);
}

/** Attachment ids uploaded during the current intake conversation segment: from
 * just after the most recent ticket-creating item up to and including the item
 * being processed. An item that already produced a ticket carries a taskId and
 * ends its segment, so an earlier turn's orphaned uploads are carried onto the
 * next ticket the agent opens (instead of being stranded on a completed item),
 * while files from an already-filed ticket or a later, independent ticket are
 * not leaked onto this one. */
function pendingAttachmentIds(session: IntakeSession, currentItem: IntakeQueueItem): string[] {
  const queue = session.queue ?? [];
  const currentIndex = queue.findIndex((item) => item.id === currentItem.id);
  if (currentIndex < 0) return [...new Set(currentItem.attachmentIds ?? [])];
  let segmentStart = 0;
  for (let i = currentIndex; i >= 0; i--) {
    if (queue[i]?.taskId) {
      segmentStart = i + 1;
      break;
    }
  }
  return [
    ...new Set(queue.slice(segmentStart, currentIndex + 1).flatMap((item) => item.attachmentIds ?? []))
  ];
}

async function appendAgentMessage(root: string, scope: IntakeScope | undefined, body: string): Promise<void> {
  await addIntakeMessage(root, { author: "agent", body }, scope);
}

async function processQueueItem(
  root: string,
  scope: IntakeScope,
  item: IntakeQueueItem,
  options?: RunIntakeOptions
): Promise<void> {
  const project = await projectForScope(root, scope);
  const startedAt = intakeTimestamp();
  await markQueueItem(root, scope, item.id, {
    status: "running",
    startedAt,
    lastActivityAt: startedAt,
    activity: "classifying request"
  });

  const session = await getIntakeSession(root, scope);
  const message = queuedMessage(session, item);
  if (!message) {
    await markQueueItem(root, scope, item.id, {
      status: "failed",
      completedAt: intakeTimestamp(),
      error: "Queued intake message no longer exists."
    });
    return;
  }

  try {
    const {
      pendingDraft: _pendingDraft,
      agentSessionId: _agentSessionId,
      ...sessionWithoutDraft
    } = session;
    const classifierSession: IntakeSession = {
      ...sessionWithoutDraft,
      messages: [message]
    };
    const workflowIds = new Set((await listWorkflowSummaries(root)).map((workflow) => workflow.id));
    const workspace = project
      ? undefined
      : await resolveWorkspaceFromText(message.body, { fallbackRoot: root, harnessRoot: root });
    const { output } = await runValidatedIntakeAgentTurn(
      root,
      classifierSession,
      {
        ...options,
        onActivity: (activity) => {
          void markQueueItem(root, scope, item.id, {
            lastActivityAt: activity.at,
            activity: activity.label
          });
          options?.onActivity?.(activity);
        }
      },
      workflowIds,
      project
    );

    let draft = normalizeDraft(output.ticket);
    if (draft) draft = await validateDraftWorkflow(root, draft);

    if (draft?.ready && draft.title && draft.description) {
      const task = await createTaskFromDraft(
        root,
        draft,
        { ...(project ? { project } : {}) },
        workspace?.targets,
        pendingAttachmentIds(session, item)
      );
      await appendAgentMessage(root, scope, `Opened ticket: ${task.title}`);
      await markQueueItem(root, scope, item.id, {
        status: "completed",
        completedAt: intakeTimestamp(),
        taskId: task.id,
        activity: "ticket created"
      });
      return;
    }

    await appendAgentMessage(root, scope, output.reply);
    await markQueueItem(root, scope, item.id, {
      status: "completed",
      completedAt: intakeTimestamp(),
      activity: "classification complete"
    });
  } catch (err) {
    const error = (err as Error).message;
    await appendAgentMessage(root, scope, `Intake classification failed: ${error}`);
    await markQueueItem(root, scope, item.id, {
      status: "failed",
      completedAt: intakeTimestamp(),
      error,
      activity: "classification failed"
    });
  }
}

export async function drainIntakeQueue(root: string, options?: RunIntakeOptions): Promise<void> {
  const scope = normalizeIntakeScope(options?.scope);
  const key = `${root}:${intakeScopeKey(scope)}`;
  if (activeQueueDrains.has(key)) return;
  activeQueueDrains.add(key);
  try {
    while (true) {
      const session = await getIntakeSession(root, scope);
      const nextItem = (session.queue ?? []).find((item) => item.status === "pending");
      if (!nextItem) return;
      await processQueueItem(root, scope, nextItem, options);
    }
  } finally {
    activeQueueDrains.delete(key);
  }
}

export function startIntakeQueue(root: string, options?: RunIntakeOptions): void {
  void drainIntakeQueue(root, options).catch(() => {});
}

/** Reset a failed intake queue item to pending and re-run its classification in
 * place (the original operator message is reclassified, not duplicated). */
export async function retryIntakeQueueItem(
  root: string,
  scope: IntakeScope,
  itemId: string,
  options?: RunIntakeOptions
): Promise<IntakeSession> {
  const session = await getIntakeSession(root, scope);
  const item = (session.queue ?? []).find((queueItem) => queueItem.id === itemId);
  if (!item) {
    throw new Error("Intake item not found.");
  }
  if (item.status !== "failed") {
    throw new Error("Only failed intake items can be retried.");
  }
  await updateIntakeSession(root, scope, (current) => ({
    ...current,
    queue: (current.queue ?? []).map((queueItem) => {
      if (queueItem.id !== itemId) return queueItem;
      const {
        error: _error,
        completedAt: _completedAt,
        startedAt: _startedAt,
        lastActivityAt: _lastActivityAt,
        activity: _activity,
        ...reset
      } = queueItem;
      return { ...reset, status: "pending" as const };
    }),
    updatedAt: intakeTimestamp()
  }));
  void startIntakeQueue(root, { ...options, scope });
  return getIntakeSession(root, scope);
}
