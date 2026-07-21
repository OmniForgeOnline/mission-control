import { formatAttachmentReference, mergeAttachments } from "../attachments/paths.ts";
import { extractPlanFromTask } from "../prompts/plan-approval.ts";
import type { HarnessTask } from "../types.ts";
import type { WorkflowDefinition, WorkflowStep } from "../workflows/types.ts";

const MAX_SECTION_CHARS = 4_000;
const MAX_TOTAL_CHARS = 12_000;
const MAX_PRIOR_HANDOFFS = 3;

export interface ReviewSupportingEvidenceInput {
  task: HarnessTask;
  step?: WorkflowStep;
  workflow?: WorkflowDefinition;
  harnessRoot: string;
  /** Primary artifact body already surfaced to the reviewer. */
  excludeAuthorReply?: string;
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[truncated]`;
}

function formatTaskLinks(task: HarnessTask): string | undefined {
  if (!task.links.length) return undefined;
  return task.links.map((link) => `- ${link.label}: ${link.url}`).join("\n");
}

function formatAttachmentMetadata(task: HarnessTask, harnessRoot: string): string | undefined {
  const attachments = mergeAttachments(
    ...((task.messages ?? []).map((message) => message.attachments)),
    task.attachments
  );
  if (!attachments.length) return undefined;
  return attachments
    .map((attachment) => `- ${formatAttachmentReference(harnessRoot, attachment)}`)
    .join("\n");
}

function priorStepHandoffs(
  task: HarnessTask,
  workflow: WorkflowDefinition | undefined,
  excludeAuthorReply?: string
): string | undefined {
  const completed = new Set(task.workflowRun?.completedSteps ?? []);
  const excluded = excludeAuthorReply?.trim();
  const blocks: string[] = [];

  for (const message of task.messages ?? []) {
    if (message.author !== "agent") continue;
    const body = message.body.trim();
    if (!body || body === excluded) continue;
    if (message.stepId && completed.has(message.stepId)) {
      const label = workflow?.steps[message.stepId]?.objective ?? message.stepId;
      blocks.push(`#### ${label}\n${truncate(body, MAX_SECTION_CHARS)}`);
    }
  }

  if (!blocks.length) {
    const agentMessages = (task.messages ?? []).filter((message) => message.author === "agent");
    for (const message of agentMessages.slice(0, -1)) {
      const body = message.body.trim();
      if (!body || body === excluded) continue;
      const label = message.stepId ?? "prior agent turn";
      blocks.push(`#### ${label}\n${truncate(body, MAX_SECTION_CHARS)}`);
    }
  }

  if (!blocks.length) return undefined;
  return blocks.slice(-MAX_PRIOR_HANDOFFS).join("\n\n");
}

/** Bounded task context for non-code review profiles (plan, links, attachments, prior steps). */
export function gatherReviewSupportingEvidence(input: ReviewSupportingEvidenceInput): string {
  const sections: string[] = [];

  if (input.step?.entryContext?.trim()) {
    sections.push(`### Step entry context\n${truncate(input.step.entryContext, MAX_SECTION_CHARS)}`);
  }

  const plan = extractPlanFromTask(input.task);
  if (plan && plan !== input.excludeAuthorReply?.trim()) {
    sections.push(`### Approved plan\n${truncate(plan, MAX_SECTION_CHARS)}`);
  }

  const links = formatTaskLinks(input.task);
  if (links) sections.push(`### Task links\n${links}`);

  const attachments = formatAttachmentMetadata(input.task, input.harnessRoot);
  if (attachments) sections.push(`### Attachments\n${attachments}`);

  const prior = priorStepHandoffs(input.task, input.workflow, input.excludeAuthorReply);
  if (prior) sections.push(`### Prior step handoffs\n${prior}`);

  return truncate(sections.join("\n\n"), MAX_TOTAL_CHARS);
}
