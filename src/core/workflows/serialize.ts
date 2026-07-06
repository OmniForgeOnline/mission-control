import { stringify } from "yaml";

import type { WorkflowDefinition, WorkflowStep } from "./types.ts";

// camelCase (runtime) -> snake_case (YAML) for the fields that differ.
// Fields not listed here keep the same name on both sides.
const STEP_FIELDS: ReadonlyArray<readonly [yamlKey: string, field: keyof WorkflowStep]> = [
  ["kind", "kind"],
  ["agent", "agent"],
  ["effort", "effort"],
  ["skill", "skill"],
  ["extensions", "extensions"],
  ["modifies_repo", "modifiesRepo"],
  ["approval", "approval"],
  ["next", "next"],
  ["parallel", "parallel"],
  ["branch", "branch"],
  ["join", "join"],
  ["join_policy", "joinPolicy"],
  ["merge_request_title", "mergeRequestTitle"],
  ["merge_request_description", "mergeRequestDescription"]
];

function serializeStep(step: WorkflowStep): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [yamlKey, field] of STEP_FIELDS) {
    const value = step[field];
    if (value !== undefined) out[yamlKey] = value;
  }
  return out;
}

/**
 * Serialize a workflow definition back to canonical YAML. Output is stable
 * (fixed key order, snake_case keys, header comment) so re-saving an
 * unedited workflow produces no diff and validateWorkflow accepts the
 * result on a round-trip.
 */
export function serializeWorkflow(def: WorkflowDefinition): string {
  const doc = {
    id: def.id,
    name: def.name,
    initial: def.initial,
    defaults: {
      agents: { author: def.defaults.author, reviewer: def.defaults.reviewer },
      ...(def.defaults.effort !== undefined ? { effort: def.defaults.effort } : {})
    },
    steps: Object.fromEntries(
      Object.entries(def.steps).map(([id, step]) => [id, serializeStep(step)])
    )
  };
  const header =
    "# Harness workflow definition. Managed by the Workflows tab; edits round-trip to YAML.\n";
  return header + stringify(doc);
}
