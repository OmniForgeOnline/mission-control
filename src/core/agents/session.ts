import { createHash } from "node:crypto";

import type { ModelPoolId, ToolId, HarnessTask } from "../types.ts";

export interface AgentSessionContext {
  agent: ToolId;
  modelPool?: ModelPoolId;
  conversation: boolean;
  stableHash?: string;
}

export function canResumeAgentSession(task: HarnessTask, context: AgentSessionContext): boolean {
  if (!task.agentSessionId) return false;
  if (!task.agentSessionAgent || task.agentSessionAgent !== context.agent) return false;
  // A session created with one model pool must not be resumed under another.
  if ((task.agentSessionModelPool ?? undefined) !== (context.modelPool ?? undefined)) return false;
  if (task.agentSessionStableHash && context.stableHash && task.agentSessionStableHash !== context.stableHash) {
    return false;
  }
  return task.agentSessionConversation === context.conversation;
}

export function clearAgentSession(): Pick<
  HarnessTask,
  "agentSessionId" | "agentSessionAgent" | "agentSessionModelPool" | "agentSessionConversation" | "agentSessionStableHash"
> {
  return {};
}

export function agentSessionFromTurn(
  sessionId: string | undefined,
  agent: ToolId,
  conversation: boolean,
  modelPool?: ModelPoolId,
  stableHash?: string
): Pick<
  HarnessTask,
  "agentSessionId" | "agentSessionAgent" | "agentSessionModelPool" | "agentSessionConversation" | "agentSessionStableHash"
> {
  if (!sessionId) return {};
  return {
    agentSessionId: sessionId,
    agentSessionAgent: agent,
    ...(modelPool !== undefined ? { agentSessionModelPool: modelPool } : {}),
    agentSessionConversation: conversation,
    ...(stableHash !== undefined ? { agentSessionStableHash: stableHash } : {})
  };
}

export function hashStableInstructions(stable: string): string {
  return createHash("sha256").update(stable, "utf8").digest("hex");
}
