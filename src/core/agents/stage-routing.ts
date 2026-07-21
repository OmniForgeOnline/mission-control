import type { RouteRequest } from "./config/optimizer.ts";
import type { AgentConfigBundle } from "./config/types.ts";
import { resolveInstalledToolIds } from "./runtime/installed.ts";
import { capabilityForWorkflowStep } from "./capability-profiles/index.ts";
import type { ToolId } from "../types.ts";
import type { WorkflowDefinition } from "../workflows/index.ts";

/** Capability a model pool must advertise for a workflow role. */
export function roleCapability(stepAgent: string | undefined): string {
  return stepAgent === "reviewer" ? "reviewer" : "author";
}

export function buildRouteRequest(
  capability: string,
  workflowId: string,
  step: WorkflowDefinition["steps"][string] | undefined,
  preferred: ToolId
): RouteRequest {
  const stepCapability = step ? capabilityForWorkflowStep(workflowId, step) : undefined;
  return {
    role: capability,
    capability,
    preferredToolId: preferred,
    ...(stepCapability?.requiredFeatures ? { requiredFeatures: stepCapability.requiredFeatures } : {})
  };
}

export interface EnrichRouteRequestOptions {
  /** When false, routing preview ignores PATH install probes (execution still filters at launch). */
  includeInstalledToolIds?: boolean;
}

/** Enrich a base route request with optional install probes. */
export async function enrichRouteRequest(
  root: string,
  bundle: AgentConfigBundle,
  base: RouteRequest,
  cwd?: string,
  options: EnrichRouteRequestOptions = {}
): Promise<RouteRequest> {
  const probeCwd = cwd ?? root;
  const installedToolIds =
    options.includeInstalledToolIds === false
      ? undefined
      : resolveInstalledToolIds(bundle.tools, probeCwd);
  return {
    ...base,
    ...(installedToolIds ? { installedToolIds } : {})
  };
}
