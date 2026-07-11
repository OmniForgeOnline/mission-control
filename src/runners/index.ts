import type { ToolId, ModelPoolId } from "../core/types.ts";
import { resolveLaunchByIds, resolveRunnerLaunch } from "../core/agents/config/launch.ts";
import { HeadlessAgentRunner, type RunnerLaunchContext } from "./headless.ts";
import { AcpAgentRunner } from "./acp/runner.ts";
import type { AgentRunner } from "./types.ts";

/** Build the concrete runner for a resolved launch (ACP agents use JSON-RPC). */
function realRunner(agent: ToolId, launch: RunnerLaunchContext): AgentRunner {
  if (launch.tool.adapter === "acp") {
    return new AcpAgentRunner(agent, launch);
  }
  return new HeadlessAgentRunner(agent, launch);
}

export function createAgentRunner(agent: ToolId, launch?: RunnerLaunchContext): AgentRunner {
  if (!launch) {
    throw new Error(`A launch context (tool + model pool) is required to run "${agent}".`);
  }
  return realRunner(agent, launch);
}

/**
 * Create a runner whose launch is resolved from the agent config (tool + best
 * model pool for the role). Used by callers without a routing decision (intake,
 * quality-gate generation). Step execution uses createRunnerForRouting instead,
 * which honors the routing's chosen pool (no-arg default or an explicit pin).
 */
export async function createRunnerForTool(
  root: string,
  agent: ToolId,
  role: string
): Promise<AgentRunner> {
  const launch = await resolveRunnerLaunch(root, agent, role);
  if (!launch) {
    throw new Error(`No eligible model pool for tool "${agent}" (role "${role}").`);
  }
  return realRunner(agent, launch);
}

/**
 * Create a runner for an already-resolved routing decision. Uses the exact pool
 * the router chose (the no-arg default, or an operator pin) instead of
 * re-selecting via the optimizer — the two must not diverge.
 */
export async function createRunnerForRouting(
  root: string,
  routing: { toolId: ToolId; modelPoolId: ModelPoolId }
): Promise<AgentRunner> {
  const launch = await resolveLaunchByIds(root, routing.toolId, routing.modelPoolId);
  if (!launch) {
    throw new Error(`No eligible model pool "${routing.modelPoolId}" for tool "${routing.toolId}".`);
  }
  return realRunner(routing.toolId, launch);
}
