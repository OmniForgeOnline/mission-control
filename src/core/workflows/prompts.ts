import { mergeAttachments, withAttachmentReferences } from "../attachments/paths.ts";
import { healStreamedMarkdown, sanitizeAgentMessageBody } from "../agents/output.ts";
import { formatOperatorNotes } from "../prompts/operator-notes.ts";
import type { ToolId, HarnessTask } from "../types.ts";

export { extractFinalPlan } from "../prompts/plan-markers.ts";
export { splitPlanningMessage, type PlanningMessageParts } from "./planning-message.ts";
import type { WorkflowStep } from "./index.ts";

const PLANNING_TURN_HEADER_RE = /^### Planning turn \d+\n\n/;

/** Normalize agent stdout or stored message text before plan-marker extraction. */
export function normalizeReplyForPlanExtraction(reply: string, agent?: ToolId): string {
  const stripped = reply.replace(PLANNING_TURN_HEADER_RE, "").trim();
  if (!stripped) return "";
  if (agent === "grok" || looksLikeStreamedAgentOutput(stripped)) {
    return sanitizeAgentMessageBody(stripped);
  }
  return healStreamedMarkdown(stripped);
}

function looksLikeStreamedAgentOutput(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const jsonLines = lines.filter((line) => line.startsWith("{") && line.endsWith("}"));
  return jsonLines.length >= 2 && jsonLines.length / lines.length >= 0.5;
}

/** True when the operator sent a message after the most recent agent turn. */
export function hasOperatorReplySinceLastAgentTurn(task: HarnessTask): boolean {
  const messages = task.messages ?? [];
  let lastAgentIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.author === "agent") {
      lastAgentIdx = i;
      break;
    }
  }
  if (lastAgentIdx === -1) return false;
  return messages.slice(lastAgentIdx + 1).some((m) => m.author === "operator");
}

export function buildConversationPrompt(
  task: HarnessTask,
  step: WorkflowStep,
  workspaceCwd: string,
  harnessRoot: string,
  kernelHeader: string,
  memorySection = ""
): string {
  const transcript = (task.messages ?? [])
    .map((m) => {
      const role = m.author === "operator" ? "Operator" : m.author === "agent" ? "Agent" : "System";
      return `[${role}]: ${withAttachmentReferences(m.body, harnessRoot, m.attachments)}`;
    })
    .join("\n\n");

  const agentTurnCount = (task.messages ?? []).filter((m) => m.author === "agent").length;
  const skillHint = step.skill ? `\nLoad the \`${step.skill}\` skill with \`read_skill\` if it helps structure this conversation.` : "";

  const instructions = `You are in a multi-turn planning conversation for workflow step "${step.id}".

Rules for this turn:
- Ask exactly ONE blocking question if you still need information to produce a solid plan.
- Do not ask multiple questions in one turn.
- If you have enough information, emit the final plan inside a fenced block:

<proposed_plan>
# Plan title
...structured markdown plan...
</proposed_plan>

Alternatively you may prefix the final plan with \`FINAL_PLAN:\` on its own line.

Until you emit a final plan marker, the ticket stays interactive and the operator may answer your question.

When producing a final plan:
- Use clear step titles, dependencies, and effort estimates (low/medium/high).
- End with scope summary and risks or open questions.${skillHint}`;

  return `${kernelHeader}
${memorySection ? `\n${memorySection}\n` : ""}
## Workflow step: ${step.id}

## Workspace
- cwd: ${workspaceCwd}

## Task
${task.title}

${withAttachmentReferences(task.description, harnessRoot, task.attachments)}

## Conversation so far (agent turns completed: ${agentTurnCount})

${transcript || "(no messages yet)"}

## Operator notes

${formatOperatorNotes(task.messages)}

## Instructions

${instructions}

Do NOT edit any files. Do NOT execute any commands. Only plan and converse.`;
}

export function buildConversationFollowupPrompt(
  task: HarnessTask,
  step: WorkflowStep,
  workspaceCwd: string,
  harnessRoot: string,
  kernelHeader: string,
  memorySection = ""
): string {
  const operatorReply = (task.messages ?? []).filter((m) => m.author === "operator").at(-1)?.body?.trim();
  const transcript = (task.messages ?? [])
    .map((m) => {
      const role = m.author === "operator" ? "Operator" : m.author === "agent" ? "Agent" : "System";
      return `[${role}]: ${withAttachmentReferences(m.body, harnessRoot, m.attachments)}`;
    })
    .join("\n\n");
  const agentTurnCount = (task.messages ?? []).filter((m) => m.author === "agent").length;
  const skillHint = step.skill ? `\nLoad the \`${step.skill}\` skill with \`read_skill\` if it helps structure this conversation.` : "";

  const instructions = `You are continuing the planning conversation for workflow step "${step.id}".

The operator sent feedback to refine the plan (they did not approve it — approval is a separate UI action).

Rules for this turn:
- Incorporate the operator's latest feedback.
- Ask exactly ONE blocking question if you still need information.
- Otherwise emit an updated plan inside:

<proposed_plan>
# Plan title
...structured markdown plan...
</proposed_plan>

Alternatively you may prefix the updated plan with \`FINAL_PLAN:\` on its own line.

When producing an updated plan:
- Use clear step titles, dependencies, and effort estimates (low/medium/high).
- End with scope summary and risks or open questions.${skillHint}`;

  return `${kernelHeader}
${memorySection ? `\n${memorySection}\n` : ""}
## Workflow step: ${step.id}

## Workspace
- cwd: ${workspaceCwd}

## Task
${task.title}

${withAttachmentReferences(task.description, harnessRoot, task.attachments)}

## Conversation so far (agent turns completed: ${agentTurnCount})

${transcript || "(no messages yet)"}

## Operator feedback (this turn)

${operatorReply || "(no operator message provided)"}

## Instructions

${instructions}

Do NOT edit any files. Do NOT execute any commands. Only plan and converse.`;
}

export function buildFollowupPrompt(task: HarnessTask, harnessRoot: string, memorySection = ""): string {
  const operatorMessages = (task.messages ?? []).filter((m) => m.author === "operator");
  const latest = operatorMessages.at(-1);
  // Task-level attachments (intake uploads, ClickUp imports appended after the
  // first turn) must reach the agent on follow-up turns too. Merge them after
  // the latest message's own attachments, deduped by id, so each reference is
  // emitted at most once.
  const attachments = mergeAttachments(latest?.attachments, task.attachments);
  const body = latest
    ? withAttachmentReferences(latest.body, harnessRoot, attachments)
    : "Operator did not provide a message. Continue from your last turn or ask a focused question.";
  if (!memorySection) return body;
  return `${memorySection}

## Operator message

${body}`;
}
