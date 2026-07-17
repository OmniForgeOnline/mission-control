import type { RunnerAdapter } from "../core/agents/config/types.ts";
import type { WorkflowStep } from "../core/workflows/index.ts";

export interface InteractiveModeInput {
  stepKind: WorkflowStep["kind"];
  adapter: RunnerAdapter | string;
  reviewer: boolean;
  checksRemediation: boolean;
  forceHeadless?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Dual-mode gate: human-facing authoring/conversation steps run the real agent
 * TUI via a PTY; automation (review, remediation, ACP, classify) stays headless.
 */
export function shouldUseInteractiveRunner(input: InteractiveModeInput): boolean {
  if (input.forceHeadless) return false;
  if (input.reviewer || input.checksRemediation) return false;
  if (input.adapter === "acp") return false;
  if (input.stepKind !== "agent_turn" && input.stepKind !== "conversation") return false;
  const env = input.env ?? process.env;
  if (env["HARNESS_INTERACTIVE"] === "0") return false;
  return true;
}
