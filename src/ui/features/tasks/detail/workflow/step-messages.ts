import type { HarnessMessage } from "@ui/app/types.js";

export function legacyMessageStepId(message: HarnessMessage): string | null {
  const match = message.body.match(/^\[([a-z][a-z0-9_]*)\]\s*/i);
  return match?.[1] ?? null;
}

export function messageStepId(message: HarnessMessage): string | null {
  return message.stepId ?? legacyMessageStepId(message);
}

export function operatorMessageStepId(message: HarnessMessage): string | null {
  if (message.author !== "operator") return null;
  return messageStepId(message);
}

/** Messages belonging to a workflow step, including agent/system replies in the same turn. */
export function messagesForStep(messages: HarnessMessage[], stepId: string): HarnessMessage[] {
  const scoped: HarnessMessage[] = [];
  let activeScope: string | null = null;

  for (const message of messages) {
    if (message.author === "operator") {
      activeScope = operatorMessageStepId(message);
      if (activeScope === stepId) scoped.push(message);
      continue;
    }

    if (message.stepId) {
      activeScope = message.stepId;
      if (activeScope === stepId) scoped.push(message);
      continue;
    }

    if (activeScope === stepId) {
      scoped.push(message);
    }
  }

  return scoped;
}

export function countStepComments(messages: HarnessMessage[], stepId: string): number {
  return messagesForStep(messages, stepId).filter((message) => message.author === "operator").length;
}
