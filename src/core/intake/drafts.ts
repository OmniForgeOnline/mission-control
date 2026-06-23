import type { ProjectRecord } from "../projects/registry.ts";
import { createTask } from "../tasks/tasks.ts";
import type { HarnessTarget, HarnessTask, IntakeTicketDraft } from "../types.ts";
import { DEFAULT_WORKFLOW_ID, listWorkflowSummaries, loadWorkflow } from "../workflows/index.ts";
import {
  parseAndValidateIntakeReply,
  type IntakeValidationResult
} from "./schema.ts";

export interface ParsedIntakeReply {
  reply: string;
  draft?: IntakeTicketDraft;
}

export interface IntakeTaskContext {
  project?: ProjectRecord;
}

function validationToParsed(result: IntakeValidationResult): ParsedIntakeReply | null {
  if (!result.ok) return null;
  return { reply: result.output.reply, draft: result.output.ticket };
}

/** Lenient parse for legacy stored messages and operator hydration. */
export function parseIntakeReply(raw: string, workflowIds?: ReadonlySet<string>): ParsedIntakeReply {
  const ids = workflowIds ?? new Set<string>();
  const validated = parseAndValidateIntakeReply(raw, ids, {
    allowLegacyFence: true,
    requireKnownWorkflow: false
  });
  const parsed = validationToParsed(validated);
  if (parsed) return parsed;
  return { reply: raw.trim() };
}

export function normalizeDraft(draft: IntakeTicketDraft | undefined): IntakeTicketDraft | undefined {
  if (!draft) return undefined;

  let normalized = draft;
  if (normalized.ready) {
    if (!normalized.title || !normalized.description) {
      normalized = { ...normalized, ready: false };
    } else if (normalized.workflowId) {
      /* validated async in callers */
    }
  }
  return normalized;
}

export async function draftFromLastAgentMessage(
  root: string,
  messages: Array<{ author: string; body: string }>
): Promise<IntakeTicketDraft | undefined> {
  const lastAgent = [...messages].reverse().find((message) => message.author === "agent");
  if (!lastAgent) return undefined;
  const workflowIds = new Set((await listWorkflowSummaries(root)).map((workflow) => workflow.id));
  return normalizeDraft(parseIntakeReply(lastAgent.body, workflowIds).draft);
}

export async function validateDraftWorkflow(root: string, draft: IntakeTicketDraft): Promise<IntakeTicketDraft> {
  if (!draft.ready || !draft.workflowId) return draft;
  try {
    await loadWorkflow(root, draft.workflowId);
    return draft;
  } catch {
    return {
      ...draft,
      ready: false,
      workflowId: null,
      rationale: `${draft.rationale} (Suggested workflow "${draft.workflowId}" is not bundled.)`.trim()
    };
  }
}

async function resolveIntakeWorkflowId(root: string, draft: IntakeTicketDraft): Promise<string> {
  if (draft.workflowId) {
    try {
      await loadWorkflow(root, draft.workflowId);
      return draft.workflowId;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_WORKFLOW_ID;
}

function projectRepoTarget(project: ProjectRecord): HarnessTarget {
  return {
    raw: `@${project.repoPath}`,
    path: project.repoPath,
    kind: "directory"
  };
}

export async function createTaskFromDraft(
  root: string,
  draft: IntakeTicketDraft,
  context: IntakeTaskContext = {},
  targets?: HarnessTarget[],
  attachmentIds?: string[]
): Promise<HarnessTask> {
  const workflowId = await resolveIntakeWorkflowId(root, draft);
  const projectTargets = context.project ? targets ?? [projectRepoTarget(context.project)] : targets;
  return createTask(root, {
    title: draft.title,
    description: `${draft.description}\n\n---\nIntake rationale: ${draft.rationale}`,
    workflowId,
    source: "intake",
    links: [],
    ...(projectTargets !== undefined ? { targets: projectTargets } : {}),
    ...(context.project ? { projectId: context.project.id, repoPath: context.project.repoPath } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {})
  });
}
