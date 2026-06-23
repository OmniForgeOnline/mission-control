import { sanitizeAgentMessageBody } from "../agents/output.ts";
import { splitPlanContent } from "../prompts/plan-markers.ts";

export interface PlanningMessageParts {
  turnLabel?: string;
  preamble: string;
  plan: string;
}

/** Split a planning-thread message into narrative and proposed-plan sections for UI rendering. */
export function splitPlanningMessage(body: string): PlanningMessageParts | null {
  const sanitized = sanitizeAgentMessageBody(body);
  const turnMatch = sanitized.match(/^(### Planning turn \d+)\n\n/);
  const turnLabel = turnMatch?.[1];
  const content = turnMatch ? sanitized.slice(turnMatch[0].length) : sanitized;

  const parts = splitPlanContent(content);
  if (!parts) return null;
  return { ...(turnLabel !== undefined ? { turnLabel } : {}), preamble: parts.preamble, plan: parts.plan };
}
