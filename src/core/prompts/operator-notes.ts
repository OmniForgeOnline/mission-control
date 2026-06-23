import type { HarnessMessage } from "../types.ts";

/** Format operator-authored task messages for agent prompts (oldest first). */
export function formatOperatorNotes(messages: HarnessMessage[] | undefined): string {
  if (!messages?.length) return "- none";
  return messages
    .filter((m) => m.author === "operator")
    .map((m) => {
      const scope = m.stepId ? ` [step:${m.stepId}]` : "";
      return `- ${m.createdAt}${scope}: ${m.body}`;
    })
    .join("\n") || "- none";
}