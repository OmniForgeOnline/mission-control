import { getProject } from "../../core/projects/registry.ts";
import { defineProjectJob } from "../../core/projects/scoped-autonomy.ts";
import {
  validateProjectJobDefinition,
  PROJECT_JOB_REQUIRED,
  PROJECT_JOB_PROPERTIES
} from "../../core/projects/job-schema.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

/**
 * Shared `job` input shape. Mirrors PROJECT_JOB_JSON_SCHEMA so an agent can read
 * the tool definition to author a job, then validate it.
 */
const JOB_INPUT_PROPERTY = {
  type: "object",
  description: "Project-scoped autonomy job definition.",
  additionalProperties: false,
  required: [...PROJECT_JOB_REQUIRED],
  properties: { ...PROJECT_JOB_PROPERTIES }
} as const;

export const projectJobTools: McpToolModule = {
  definitions: [
    {
      name: "validate_project_job",
      description:
        "Validate a project-scoped autonomy job definition against the predefined schema without persisting it. Returns { valid, job? , errors? }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { job: JOB_INPUT_PROPERTY },
        required: ["job"]
      }
    },
    {
      name: "define_project_job",
      description:
        "Validate a project-scoped job against the schema and register it for a project (offered in its job list). Custom jobs with no built-in handler require `instructions`. Returns the persisted job or validation errors.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          projectId: { type: "string", description: "Optional; defaults to the current turn's project." },
          job: JOB_INPUT_PROPERTY
        },
        required: ["job"]
      }
    }
  ],
  handlers: {
    validate_project_job: async (_ctx, args) => {
      const result = validateProjectJobDefinition(args["job"]);
      return asText(
        result.ok ? { valid: true, job: result.job } : { valid: false, errors: result.errors }
      );
    },
    define_project_job: async (ctx, args) => {
      const explicit = typeof args["projectId"] === "string" ? args["projectId"].trim() : "";
      const projectId = explicit || ctx.projectId || "";
      if (!projectId) {
        throw new Error("projectId is required (pass it explicitly or run in a project-scoped turn).");
      }
      const project = await getProject(ctx.root, projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const result = await defineProjectJob(ctx.root, projectId, args["job"]);
      return asText(result.ok ? { ok: true, job: result.job } : { ok: false, errors: result.errors });
    }
  }
};
