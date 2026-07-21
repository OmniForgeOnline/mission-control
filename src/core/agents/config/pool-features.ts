import type { CapabilityFeature } from "../capability-profiles/types.ts";
import { capabilitiesForAdapter } from "./capabilities.ts";
import { extractConfiguredModel } from "./model-identity.ts";
import type { AgentToolConfig, ModelPoolConfig } from "./types.ts";

function toolStreamsTools(tool: AgentToolConfig): boolean {
  return tool.cli.streamTools ?? capabilitiesForAdapter(tool.adapter).streamTools;
}

/** Whether a tool/pool pair advertises a routing capability feature. */
export function poolSupportsFeature(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  feature: CapabilityFeature
): boolean {
  if (pool.features?.includes(feature)) return true;
  switch (feature) {
    case "tool-use":
      return toolStreamsTools(tool);
    case "large-context":
      // ponytail: no-arg default pools inherit the tool's own context window.
      return pool.modelArgs.length === 0;
    case "vision": {
      const model = extractConfiguredModel(pool.modelArgs).toLowerCase();
      if (model === "(default)") return true;
      return /opus|sonnet|gpt-4|gpt-5|gemini|grok-2|grok-3|vision|fable/.test(model);
    }
    case "custom-provider":
      if (pool.modelArgs.length === 0) return true;
      if (tool.adapter === "generic") return true;
      if (pool.identity?.endpointProof) return true;
      return pool.identity?.verificationState === "verified";
    default:
      return false;
  }
}

export function poolSupportsRequiredFeatures(
  tool: AgentToolConfig,
  pool: ModelPoolConfig,
  required?: CapabilityFeature[]
): boolean {
  if (!required?.length) return true;
  return required.every((feature) => poolSupportsFeature(tool, pool, feature));
}
