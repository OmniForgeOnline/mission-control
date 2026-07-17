import type { ToolId, ModelPoolId } from "../core/types.ts";
import type { WorkflowStep } from "../core/workflows/index.ts";
import { resolveLaunchByIds, resolveRunnerLaunch } from "../core/agents/config/launch.ts";
import { HeadlessAgentRunner, type RunnerLaunchContext } from "./headless.ts";
import { AcpAgentRunner } from "./acp/runner.ts";
import { InteractiveAgentRunner } from "./interactive.ts";
import { shouldUseInteractiveRunner } from "./interactive-mode.ts";
import type { AgentRunner } from "./types.ts";

export interface CreateRunnerOptions {
  /**
   * Force interactive (true) or headless (false). When omitted, `stepContext`
   * is used to decide dual-mode routing.
   */
  interactive?: boolean;
  /** Workflow step context for dual-mode interactive vs headless selection. */
  stepContext?: {
    stepKind: WorkflowStep["kind"];
    reviewer?: boolean;
    checksRemediation?: boolean;
  };
}

function resolveInteractive(
  launch: RunnerLaunchContext,
  options: CreateRunnerOptions
): boolean {
  if (options.interactive === true) return launch.tool.adapter !== "acp";
  if (options.interactive === false) return false;
  if (!options.stepContext) return false;
  return shouldUseInteractiveRunner({
    stepKind: options.stepContext.stepKind,
    adapter: launch.tool.adapter,
    reviewer: Boolean(options.stepContext.reviewer),
    checksRemediation: Boolean(options.stepContext.checksRemediation)
  });
}

/** Build the concrete runner for a resolved launch (ACP agents use JSON-RPC). */
function realRunner(
  agent: ToolId,
  launch: RunnerLaunchContext,
  options: CreateRunnerOptions = {}
): AgentRunner {
  if (launch.tool.adapter === "acp") {
    return new AcpAgentRunner(agent, launch);
  }
  if (resolveInteractive(launch, options)) {
    return new InteractiveAgentRunner(agent, launch);
  }
  return new HeadlessAgentRunner(agent, launch);
}

export function createAgentRunner(
  agent: ToolId,
  launch?: RunnerLaunchContext,
  options: CreateRunnerOptions = {}
): AgentRunner {
  if (!launch) {
    throw new Error(`A launch context (tool + model pool) is required to run "${agent}".`);
  }
  return realRunner(agent, launch, options);
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
  role: string,
  options: CreateRunnerOptions = {}
): Promise<AgentRunner> {
  const launch = await resolveRunnerLaunch(root, agent, role);
  if (!launch) {
    throw new Error(`No eligible model pool for tool "${agent}" (role "${role}").`);
  }
  return realRunner(agent, launch, options);
}

/**
 * Create a runner for an already-resolved routing decision. Uses the exact pool
 * the router chose (the no-arg default, or an operator pin) instead of
 * re-selecting via the optimizer — the two must not diverge.
 */
export async function createRunnerForRouting(
  root: string,
  routing: { toolId: ToolId; modelPoolId: ModelPoolId },
  options: CreateRunnerOptions = {}
): Promise<AgentRunner> {
  const launch = await resolveLaunchByIds(root, routing.toolId, routing.modelPoolId);
  if (!launch) {
    throw new Error(`No eligible model pool "${routing.modelPoolId}" for tool "${routing.toolId}".`);
  }
  return realRunner(routing.toolId, launch, options);
}
