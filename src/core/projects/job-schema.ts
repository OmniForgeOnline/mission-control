import { parseSchedule } from "../../autonomy/job-schedule.ts";
import type { AutonomyApprovalPolicy, AutonomyRunMode } from "../../autonomy/job-types.ts";

/**
 * The authored shape of a project-scoped autonomy job: what an operator or
 * agent defines. Excludes runtime/operational fields (status, lastRunAt,
 * nextRunAt, lastSummary), which the job runner owns. The harness guidance
 * sweep is the reference instance this schema is derived from.
 */
export interface ProjectJobDefinition {
  id: string;
  title: string;
  description: string;
  /** Interval: "every-Nm" | "every-Nh" | "every-Nd" (see parseSchedule). */
  schedule: string;
  runMode: AutonomyRunMode;
  approvalPolicy: AutonomyApprovalPolicy;
  /** Agent-turn prompt for jobs with no built-in handler. */
  instructions?: string;
}

export type ProjectJobValidation =
  | { ok: true; job: ProjectJobDefinition }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const APPROVAL_POLICIES: readonly AutonomyApprovalPolicy[] = ["proposal-only", "read-only", "synthetic-task"];
const RUN_MODES: readonly AutonomyRunMode[] = ["manual", "automatic"];

/**
 * Machine-readable JSON Schema for a project job definition. Agents authoring a
 * job read this to know the shape; `validateProjectJobDefinition` is the actual
 * runtime check. Kept hand-rolled (no validator dependency); the two must stay
 * in sync, which the schema tests pin down.
 */
export const PROJECT_JOB_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ProjectJobDefinition",
  description: "An autonomy job scoped to a single onboarded project.",
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "description", "schedule", "runMode", "approvalPolicy"],
  properties: {
    id: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]{0,62}$",
      description: "Lowercase-dash identifier, unique within the project (e.g. 'tech-debt-sweep')."
    },
    title: { type: "string", minLength: 1, description: "Human-readable job title." },
    description: { type: "string", minLength: 1, description: "One-line summary of what the job does." },
    schedule: {
      type: "string",
      pattern: "^every-(\\d+)([mhd])$",
      description: "Interval: every-30m, every-1h, every-1d."
    },
    runMode: { type: "string", enum: ["manual", "automatic"] },
    approvalPolicy: { type: "string", enum: ["proposal-only", "read-only", "synthetic-task"] },
    instructions: {
      type: "string",
      description: "Agent-turn prompt. Required for jobs with no built-in handler."
    }
  }
} as const;

export const PROJECT_JOB_REQUIRED: readonly string[] = PROJECT_JOB_JSON_SCHEMA.required;
export const PROJECT_JOB_PROPERTIES: Readonly<Record<string, unknown>> = PROJECT_JOB_JSON_SCHEMA.properties;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

export function validateProjectJobDefinition(input: unknown): ProjectJobValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Job definition must be an object."] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isString(raw["id"]) || !ID_PATTERN.test(raw["id"])) {
    errors.push("id must be a lowercase-dash identifier (e.g. 'tech-debt-sweep').");
  }
  if (!isNonEmptyString(raw["title"])) {
    errors.push("title must be a non-empty string.");
  }
  if (!isNonEmptyString(raw["description"])) {
    errors.push("description must be a non-empty string.");
  }
  if (!isString(raw["schedule"]) || parseSchedule(raw["schedule"]) === null) {
    errors.push("schedule must be an interval like 'every-1h', 'every-30m', or 'every-1d'.");
  }
  if (!isString(raw["runMode"]) || !RUN_MODES.includes(raw["runMode"] as AutonomyRunMode)) {
    errors.push("runMode must be 'manual' or 'automatic'.");
  }
  if (!isString(raw["approvalPolicy"]) || !APPROVAL_POLICIES.includes(raw["approvalPolicy"] as AutonomyApprovalPolicy)) {
    errors.push("approvalPolicy must be 'proposal-only', 'read-only', or 'synthetic-task'.");
  }
  if (raw["instructions"] !== undefined && !isNonEmptyString(raw["instructions"])) {
    errors.push("instructions, when provided, must be a non-empty string.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const job: ProjectJobDefinition = {
    id: raw["id"] as string,
    title: (raw["title"] as string).trim(),
    description: (raw["description"] as string).trim(),
    schedule: raw["schedule"] as string,
    runMode: raw["runMode"] as AutonomyRunMode,
    approvalPolicy: raw["approvalPolicy"] as AutonomyApprovalPolicy,
    ...(isNonEmptyString(raw["instructions"]) ? { instructions: (raw["instructions"] as string).trim() } : {})
  };
  return { ok: true, job };
}
