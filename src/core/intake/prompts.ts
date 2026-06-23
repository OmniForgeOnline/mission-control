import { INTAKE_OUTPUT_JSON_SCHEMA } from "./schema.ts";
import type { IntakeScope, IntakeSession } from "../types.ts";
import type { ProjectRecord } from "../projects/registry.ts";
import type { WorkflowSummary } from "../workflows/index.ts";

export interface IntakePromptContext {
  scope: IntakeScope;
  cwd: string;
  project?: ProjectRecord;
}

function scopeGuidance(context: IntakePromptContext): string {
  if (context.scope.kind !== "project" || !context.project) {
    return `cwd: ${context.cwd}`;
  }
  return `cwd: ${context.cwd}

## Selected project

- id: ${context.project.id}
- name: ${context.project.name}
- repoPath: ${context.project.repoPath}

The target repository is already selected. Do not ask which repository to use and do not infer a different repository from the request.`;
}

export function buildIntakePrompt(
  session: IntakeSession,
  workflows: WorkflowSummary[],
  contextOrCwd: IntakePromptContext | string
): string {
  const context = typeof contextOrCwd === "string"
    ? { scope: session.scope ?? { kind: "global" as const }, cwd: contextOrCwd }
    : contextOrCwd;
  const catalog = workflows
    .map((workflow) => {
      const steps = workflow.stepIds
        .slice(0, 6)
        .map((id) => workflow.steps[id]?.kind ?? id)
        .join(" → ");
      const extra = workflow.stepIds.length > 6 ? " → …" : "";
      return `- **${workflow.id}** (${workflow.name}): ${steps}${extra}`;
    })
    .join("\n");

  const workflowIds = workflows.map((workflow) => workflow.id).join(", ");

  const transcript = session.messages
    .map((message) => `### ${message.author}\n${message.body}`)
    .join("\n\n");

  const agentTurns = session.messages.filter((message) => message.author === "agent").length;

  return `You are the Harness intake classifier. Classify exactly one operator request and draft a ticket with the best matching workflow.

## Available workflows

${catalog}

Bundled workflow ids: ${workflowIds}

## Workspace

${scopeGuidance(context)}

## Request to classify (agent turns completed: ${agentTurns})

${transcript || "(no messages yet)"}

## Rules

1. Ask at most ONE clarifying question only when scope, outcome, target repository, or category is still unclear.
2. Do NOT edit files, run commands, inspect repositories, or plan implementation. Classification and ticket drafting only.
3. Pick the closest existing workflow id from the catalog. Use null only when nothing fits and a new workflow type is warranted.
4. When ready to create a ticket, set ticket.ready to true with a crisp title and a scoped problem statement. Include target paths and operator constraints, but do not include implementation steps, test plans, or workflow-stage plans.
5. If no workflow fits, set workflowId to null and populate suggestNewWorkflow with a concrete suggested workflow (id, name, rationale, step outline).
6. Prefer high confidence only when category and outcome are explicit; otherwise keep asking or use medium/low.

## Response format (strict)

Your entire response must be one JSON object matching this schema — nothing before or after it, no markdown fences, no prose outside the JSON:

${JSON.stringify(INTAKE_OUTPUT_JSON_SCHEMA, null, 2)}

Put operator-facing prose in the reply field. Use \\n for line breaks inside JSON strings (never raw newlines inside quoted strings).

When ticket.ready is false, title and description must be empty strings and workflowId must be null.
When ticket.ready is true, title and description must be non-empty and workflowId must be a bundled workflow id or null.
When suggesting a new workflow, set workflowId to null and suggestNewWorkflow to an object with suggestedId, suggestedName, rationale, and optional outline.`;
}

export function buildIntakeCorrectionPrompt(errors: string[]): string {
  return `Your previous intake response failed harness validation and was rejected.

Fix every issue below and respond again with a single raw JSON object (no markdown fences, no text outside JSON).

Validation errors:
${errors.map((error) => `- ${error}`).join("\n")}

Reminder: use \\n for newlines inside JSON strings; ticket.ready false requires empty title/description and null workflowId.`;
}
