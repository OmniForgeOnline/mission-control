import { escapeHtml } from "@ui/shell/dom.js";

export interface FormattedBlockedReason {
  message: string;
  hint?: string;
  recoverable: boolean;
}

const INTERNAL_PATTERNS: Array<{
  test: RegExp;
  message: string;
  hint: string;
}> = [
  {
    test: /agent definitions are not loaded/i,
    message: "Mission Control could not load agent configuration.",
    hint: "Resume the task to retry the current step."
  },
  {
    test: /does not support parameter reasoningEffort/i,
    message: "This agent does not support reasoning effort for this step.",
    hint: "Resume the task — effort is now skipped automatically for agents that do not support it."
  },
  {
    test: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network/i,
    message: "A network error interrupted the agent run.",
    hint: "Resume when connectivity is restored, or retry with a different agent."
  },
  {
    test: /usage\s+limit|out of (usage|credits)|billing_error|error_max_budget|quota\s+(exceeded|exhausted|depleted)/i,
    message: "The agent provider reported exhausted usage or billing limits.",
    hint: "Wait for limits to reset, add credits, switch model pool in Settings → Agents, or resume with a different agent."
  },
  {
    test: /purchase more credits|settings\/usage|upgrade to pro/i,
    message: "The agent provider reported exhausted usage or billing limits.",
    hint: "Add credits or switch to another agent in Settings → Agents, then resume the task."
  },
  {
    test: /rate limit|429|too many requests/i,
    message: "The agent provider rate-limited this run.",
    hint: "Wait a few minutes, then resume or switch to another agent."
  },
  {
    test: /exited with code|process exited|command failed/i,
    message: "The agent process exited unexpectedly.",
    hint: "Review the run log, then resume or try a different agent."
  },
  {
    test: /timeout|timed out|deadline exceeded/i,
    message: "The agent run timed out.",
    hint: "Resume with a lower effort level or switch agents."
  },
  {
    test: /repository binding required|bind a git repository/i,
    message: "This task needs a git repository target before it can open a merge request.",
    hint: "Bind a repository in the task overview, then resume the task."
  },
  {
    test: /agent capacity exhausted/i,
    message: "All configured agents for this step are at or over their capacity limits.",
    hint: "Raise limits, add fallbacks, or refresh usage in Settings → Agents, then resume the task."
  },
  {
    test: /exceeded maximum resume attempts/i,
    message: "This step was resumed the maximum number of times.",
    hint: "Retry with a different agent to reset the per-step limit, or adjust the task before resuming."
  }
];

export function formatBlockedReason(reason: string): FormattedBlockedReason {
  const trimmed = reason.trim();
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test.test(trimmed)) {
      return {
        message: pattern.message,
        hint: pattern.hint,
        recoverable: true
      };
    }
  }
  return { message: trimmed, recoverable: false };
}

export function blockedReasonHtml(reason: string): string {
  const formatted = formatBlockedReason(reason);
  const hint = formatted.hint ? `<div class="blocked-hint">${escapeHtml(formatted.hint)}</div>` : "";
  return `<div class="blocked-reason${formatted.recoverable ? " recoverable" : ""}">${escapeHtml(formatted.message)}${hint}</div>`;
}
