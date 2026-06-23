import { asRecord } from "../infra/record.ts";
import type { ToolId, EffortLevel } from "../types.ts";
import {
  VALID_APPROVALS,
  VALID_EFFORT_LEVELS,
  VALID_KINDS,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowStepApproval,
  type WorkflowStepAgent,
  type WorkflowStepKind
} from "./types.ts";

function parseEffortLevel(value: unknown, label: string): EffortLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const effort = typeof value === "string" ? value.trim() : "";
  if (!effort) return undefined;
  if (!VALID_EFFORT_LEVELS.has(effort as EffortLevel)) {
    throw new Error(`${label} has invalid effort "${String(value)}".`);
  }
  return effort as EffortLevel;
}

export function validateWorkflow(raw: unknown): WorkflowDefinition {
  const doc = asRecord(raw, "Workflow document")!;
  const id = typeof doc["id"] === "string" ? doc["id"].trim() : "";
  const name = typeof doc["name"] === "string" ? doc["name"].trim() : id;
  const initial = typeof doc["initial"] === "string" ? doc["initial"].trim() : "";
  if (!id) throw new Error("Workflow id is required.");
  if (!initial) throw new Error("Workflow initial step is required.");

  const stepsRaw = asRecord(doc["steps"], "Workflow steps")!;
  const steps: Record<string, WorkflowStep> = {};
  for (const [stepId, stepValue] of Object.entries(stepsRaw)) {
    const step = asRecord(stepValue, `Workflow step ${stepId}`)!;
    const kind = typeof step["kind"] === "string" ? (step["kind"].trim() as WorkflowStepKind) : "agent_turn";
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Workflow step "${stepId}" has invalid kind "${String(step["kind"])}".`);
    }
    const agent =
      typeof step["agent"] === "string"
        ? (step["agent"].trim() as WorkflowStepAgent)
        : kind === "terminal"
          ? "none"
          : "author";
    if (!agent) {
      throw new Error(`Workflow step "${stepId}" has invalid agent "${String(step["agent"])}".`);
    }
    const approval =
      typeof step["approval"] === "string" ? (step["approval"].trim() as WorkflowStepApproval) : "none";
    if (!VALID_APPROVALS.has(approval)) {
      throw new Error(`Workflow step "${stepId}" has invalid approval "${String(step["approval"])}".`);
    }
    const skill = typeof step["skill"] === "string" ? step["skill"].trim() || undefined : undefined;
    const modifiesRepo =
      step["modifies_repo"] === true ? true : step["modifies_repo"] === false ? false : undefined;
    const effort = parseEffortLevel(step["effort"], `Workflow step "${stepId}"`);
    const mergeRequestTitle =
      typeof step["merge_request_title"] === "string" ? step["merge_request_title"].trim() || undefined : undefined;
    const mergeRequestDescription =
      typeof step["merge_request_description"] === "string"
        ? step["merge_request_description"].trim() || undefined
        : undefined;
    const next = typeof step["next"] === "string" ? step["next"].trim() || undefined : undefined;
    let parallel: string[] | undefined;
    if (step["parallel"] !== undefined) {
      if (!Array.isArray(step["parallel"]) || step["parallel"].length === 0) {
        throw new Error(`Workflow step "${stepId}" parallel must be a non-empty array.`);
      }
      parallel = [];
      for (const value of step["parallel"]) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`Workflow step "${stepId}" parallel entries must be non-empty strings.`);
        }
        parallel.push(value.trim());
      }
    }
    const join = typeof step["join"] === "string" ? step["join"].trim() || undefined : undefined;
    const joinPolicyRaw = typeof step["join_policy"] === "string" ? step["join_policy"].trim() : undefined;
    const joinPolicy =
      joinPolicyRaw === "all" || joinPolicyRaw === "any"
        ? joinPolicyRaw
        : typeof step["joinPolicy"] === "string" && (step["joinPolicy"] === "all" || step["joinPolicy"] === "any")
          ? step["joinPolicy"]
          : undefined;
    let branch: Record<string, string> | undefined;
    if (step["branch"] !== undefined) {
      branch = {};
      const branchRaw = asRecord(step["branch"], `Workflow step ${stepId}.branch`)!;
      for (const [key, value] of Object.entries(branchRaw)) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`Workflow step "${stepId}" branch "${key}" must be a non-empty string.`);
        }
        branch[key] = value.trim();
      }
    }
    if (kind === "terminal" && (next || branch)) {
      throw new Error(`Workflow step "${stepId}" is terminal and must not define next or branch.`);
    }
    if (kind !== "terminal" && !next && !branch && !parallel) {
      throw new Error(`Workflow step "${stepId}" requires next, branch, or parallel.`);
    }
    if (parallel && (next || join)) {
      throw new Error(`Workflow step "${stepId}" cannot define parallel with next or join.`);
    }
    steps[stepId] = {
      id: stepId,
      kind,
      agent,
      approval,
      ...(skill !== undefined ? { skill } : {}),
      ...(modifiesRepo !== undefined ? { modifiesRepo } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(mergeRequestTitle ? { mergeRequestTitle } : {}),
      ...(mergeRequestDescription ? { mergeRequestDescription } : {}),
      ...(next !== undefined ? { next } : {}),
      ...(parallel !== undefined ? { parallel } : {}),
      ...(join !== undefined ? { join } : {}),
      ...(joinPolicy !== undefined ? { joinPolicy } : {}),
      ...(branch !== undefined ? { branch } : {})
    };
  }

  if (!steps[initial]) {
    throw new Error(`Workflow initial step "${initial}" is not defined in steps.`);
  }

  for (const [stepId, step] of Object.entries(steps)) {
    if (step.next && !steps[step.next]) {
      throw new Error(`Workflow step "${stepId}" references unknown next step "${step.next}".`);
    }
    if (step.branch) {
      for (const [event, target] of Object.entries(step.branch)) {
        if (!steps[target]) {
          throw new Error(`Workflow step "${stepId}" branch "${event}" references unknown step "${target}".`);
        }
      }
    }
    if (step.parallel) {
      for (const target of step.parallel) {
        if (!steps[target]) {
          throw new Error(`Workflow step "${stepId}" parallel references unknown step "${target}".`);
        }
      }
    }
    if (step.join && !steps[step.join]) {
      throw new Error(`Workflow step "${stepId}" references unknown join step "${step.join}".`);
    }
  }

  const defaultsRaw =
    doc["defaults"] && typeof doc["defaults"] === "object"
      ? asRecord(doc["defaults"], "Workflow defaults")!
      : {};
  const agentsRaw =
    defaultsRaw["agents"] && typeof defaultsRaw["agents"] === "object"
      ? asRecord(defaultsRaw["agents"], "Workflow defaults.agents")!
      : {};
  const authorDefault = typeof agentsRaw["author"] === "string" ? agentsRaw["author"].trim() : "claude";
  const reviewerDefault = typeof agentsRaw["reviewer"] === "string" ? agentsRaw["reviewer"].trim() : "claude";
  if (!authorDefault) {
    throw new Error(`Workflow defaults.agents.author has invalid agent "${authorDefault}".`);
  }
  if (!reviewerDefault) {
    throw new Error(`Workflow defaults.agents.reviewer has invalid agent "${reviewerDefault}".`);
  }

  const defaultEffort = parseEffortLevel(defaultsRaw["effort"], "Workflow defaults.effort");

  return {
    id,
    name,
    initial,
    defaults: {
      author: authorDefault as ToolId,
      reviewer: reviewerDefault as ToolId,
      ...(defaultEffort ? { effort: defaultEffort } : {})
    },
    steps
  };
}