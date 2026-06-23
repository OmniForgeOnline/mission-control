import { asRecord } from "../infra/record.ts";
import type { IntakeConfidence, IntakeTicketDraft, IntakeWorkflowSuggestion } from "../types.ts";

/** Programmatic intake agent output — validated before any ticket is created. */
export interface IntakeAgentOutput {
  reply: string;
  ticket: IntakeTicketDraft;
}

export interface IntakeValidationSuccess {
  ok: true;
  output: IntakeAgentOutput;
}

export interface IntakeValidationFailure {
  ok: false;
  errors: string[];
}

export type IntakeValidationResult = IntakeValidationSuccess | IntakeValidationFailure;

const CONFIDENCE_LEVELS = new Set<IntakeConfidence>(["high", "medium", "low"]);

/** Machine-readable schema included in the intake prompt. */
export const INTAKE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["reply", "ticket"],
  additionalProperties: false,
  properties: {
    reply: { type: "string", minLength: 1, description: "Short conversational message shown to the operator." },
    ticket: {
      type: "object",
      required: ["ready", "title", "description", "workflowId", "confidence", "rationale", "suggestNewWorkflow"],
      properties: {
        ready: { type: "boolean" },
        title: { type: "string" },
        description: { type: "string" },
        workflowId: { type: ["string", "null"] },
        confidence: { enum: ["high", "medium", "low"] },
        rationale: { type: "string" },
        suggestNewWorkflow: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["suggestedId", "suggestedName", "rationale"],
              properties: {
                suggestedId: { type: "string" },
                suggestedName: { type: "string" },
                rationale: { type: "string" },
                outline: { type: "string" }
              }
            }
          ]
        }
      }
    }
  }
} as const;

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseWorkflowSuggestion(raw: unknown): IntakeWorkflowSuggestion | null {
  const doc = asRecord(raw, "suggestNewWorkflow", { orNull: true });
  if (!doc) return null;
  const suggestedId = trimmedString(doc["suggestedId"]);
  const suggestedName = trimmedString(doc["suggestedName"]);
  const rationale = trimmedString(doc["rationale"]);
  const outline = trimmedString(doc["outline"]) || undefined;
  if (!suggestedId || !suggestedName) return null;
  return { suggestedId, suggestedName, rationale, ...(outline ? { outline } : {}) };
}

/** Escape raw newlines/tabs inside JSON string literals (legacy agent replies). */
export function repairJsonStringLiterals(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inString = true;
    }
  }
  return out;
}

export type IntakeJsonExtractFormat = "raw" | "fence";

function extractIntakeJsonText(raw: string): { text: string; format: IntakeJsonExtractFormat } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    return { text: trimmed, format: "raw" };
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fence) {
    return { text: fence, format: "fence" };
  }

  return null;
}

function parseIntakeJsonText(text: string): { json: unknown } | { error: string } {
  try {
    return { json: JSON.parse(text) };
  } catch (firstError) {
    try {
      return { json: JSON.parse(repairJsonStringLiterals(text)) };
    } catch {
      const message = firstError instanceof Error ? firstError.message : "Invalid JSON";
      return { error: message };
    }
  }
}

export interface ValidateIntakeOptions {
  /** When true (default), ready tickets must reference a bundled workflow id. */
  requireKnownWorkflow?: boolean;
}

export function validateIntakeAgentOutput(
  raw: unknown,
  workflowIds: ReadonlySet<string>,
  options?: ValidateIntakeOptions
): IntakeValidationResult {
  const requireKnownWorkflow = options?.requireKnownWorkflow ?? true;
  const errors: string[] = [];
  const doc = asRecord(raw, "root", { orNull: true });
  if (!doc) {
    return { ok: false, errors: ["Response must be a single JSON object."] };
  }

  const reply = trimmedString(doc["reply"]);
  if (!reply) errors.push("reply must be a non-empty string.");

  const ticketRaw = doc["ticket"] ?? doc["proposal"];
  const ticketDoc = asRecord(ticketRaw, "ticket", { orNull: true });
  if (!ticketDoc) {
    errors.push("ticket must be an object.");
    return { ok: false, errors };
  }

  if (typeof ticketDoc["ready"] !== "boolean") {
    errors.push("ticket.ready must be a boolean.");
  }

  const title = trimmedString(ticketDoc["title"]);
  const description = trimmedString(ticketDoc["description"]);
  const workflowIdRaw = ticketDoc["workflowId"];
  const workflowId =
    workflowIdRaw === null
      ? null
      : typeof workflowIdRaw === "string" && workflowIdRaw.trim()
      ? workflowIdRaw.trim()
      : workflowIdRaw === undefined
      ? null
      : "__invalid__";

  if (workflowId === "__invalid__") {
    errors.push("ticket.workflowId must be a string or null.");
  }

  const confidenceRaw = typeof ticketDoc["confidence"] === "string" ? ticketDoc["confidence"].toLowerCase() : "";
  const confidence: IntakeConfidence = CONFIDENCE_LEVELS.has(confidenceRaw as IntakeConfidence)
    ? (confidenceRaw as IntakeConfidence)
    : "medium";
  if (!CONFIDENCE_LEVELS.has(confidenceRaw as IntakeConfidence)) {
    errors.push('ticket.confidence must be "high", "medium", or "low".');
  }

  const rationale = trimmedString(ticketDoc["rationale"]);
  const suggestNewWorkflow =
    parseWorkflowSuggestion(ticketDoc["suggestNewWorkflow"] ?? ticketDoc["proposeNewWorkflow"]) ?? null;

  if (ticketDoc["suggestNewWorkflow"] !== undefined && ticketDoc["suggestNewWorkflow"] !== null && !suggestNewWorkflow) {
    errors.push("ticket.suggestNewWorkflow must be null or an object with suggestedId and suggestedName.");
  }

  const ready = ticketDoc["ready"] === true;

  if (ready) {
    if (!title) errors.push("ticket.title is required when ticket.ready is true.");
    if (!description) errors.push("ticket.description is required when ticket.ready is true.");
    if (requireKnownWorkflow && workflowId && !workflowIds.has(workflowId)) {
      errors.push(`ticket.workflowId "${workflowId}" is not a bundled workflow.`);
    }
    if (suggestNewWorkflow) {
      errors.push("ticket.suggestNewWorkflow must be null when ticket.ready is true.");
    }
  } else {
    if (title) errors.push("ticket.title must be empty when ticket.ready is false.");
    if (description) errors.push("ticket.description must be empty when ticket.ready is false.");
    if (workflowId) errors.push("ticket.workflowId must be null when ticket.ready is false.");
    if (!suggestNewWorkflow && !rationale) {
      errors.push("ticket.rationale must explain classification when ticket.ready is false.");
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  const ticket: IntakeTicketDraft = {
    ready,
    title: ready ? title : "",
    description: ready ? description : "",
    workflowId: ready ? workflowId : null,
    confidence,
    rationale,
    suggestNewWorkflow
  };

  return {
    ok: true,
    output: {
      reply: reply || "(no reply)",
      ticket
    }
  };
}

export interface ParseIntakeReplyOptions {
  /** Accept ```json fences (legacy hydration only). Live turns require raw JSON. */
  allowLegacyFence?: boolean;
  requireKnownWorkflow?: boolean;
}

export function parseAndValidateIntakeReply(
  raw: string,
  workflowIds: ReadonlySet<string>,
  options?: ParseIntakeReplyOptions
): IntakeValidationResult {
  const extracted = extractIntakeJsonText(raw);
  if (!extracted) {
    return {
      ok: false,
      errors: [
        "Response must be a single JSON object with reply and ticket fields (no prose outside the JSON)."
      ]
    };
  }

  if (extracted.format === "fence" && !options?.allowLegacyFence) {
    return {
      ok: false,
      errors: ["Do not wrap output in markdown code fences. Return raw JSON only."]
    };
  }

  const parsed = parseIntakeJsonText(extracted.text);
  if ("error" in parsed) {
    return { ok: false, errors: [`JSON parse error: ${parsed.error}`] };
  }

  return validateIntakeAgentOutput(parsed.json, workflowIds, {
    ...(options?.requireKnownWorkflow !== undefined ? { requireKnownWorkflow: options.requireKnownWorkflow } : {})
  });
}