import { extractHandoffSections } from "../merge-request/compose.ts";
import type { ReviewVerdict } from "./code-review.ts";
import type { HarnessTask } from "../types.ts";

export interface FollowupCandidate {
  source: "handoff-open" | "handoff-watch" | "review-comment" | "review-summary";
  title: string;
  detail: string;
}

function latestAuthorBody(task: HarnessTask): string {
  return (task.messages ?? []).filter((message) => message.author === "agent").at(-1)?.body?.trim() ?? "";
}

function latestReviewerBody(task: HarnessTask): string {
  return (task.messages ?? []).filter((message) => message.author === "system").at(-1)?.body?.trim() ?? "";
}

function parseReviewerJsonFromBody(body: string): ReviewVerdict | null {
  const fence = body.match(/```json\s*([\s\S]+?)```/i);
  if (!fence?.[1]) return null;
  try {
    const json = JSON.parse(fence[1].trim()) as {
      summary?: string;
      comments?: Array<{ title?: string; rationale?: string; text?: string }>;
    };
    return {
      decision: "none",
      summary: typeof json.summary === "string" ? json.summary : "",
      comments: Array.isArray(json.comments)
        ? json.comments.map((comment) => ({
            ...(comment.title !== undefined ? { title: comment.title } : {}),
            ...(comment.rationale !== undefined ? { rationale: comment.rationale } : {}),
            ...(comment.text !== undefined ? { text: comment.text } : {})
          }))
        : []
    };
  } catch {
    return null;
  }
}

export function gatherFollowupCandidates(task: HarnessTask): FollowupCandidate[] {
  const candidates: FollowupCandidate[] = [];
  const handoff = extractHandoffSections(latestAuthorBody(task));

  if (handoff.open && handoff.open.toLowerCase() !== "none") {
    candidates.push({
      source: "handoff-open",
      title: "Open item from author handoff",
      detail: handoff.open
    });
  }
  if (handoff.watch && handoff.watch.toLowerCase() !== "none") {
    candidates.push({
      source: "handoff-watch",
      title: "Residual risk from author handoff",
      detail: handoff.watch
    });
  }

  const reviewerBody = latestReviewerBody(task);
  const verdict = parseReviewerJsonFromBody(reviewerBody);
  if (verdict?.summary) {
    candidates.push({
      source: "review-summary",
      title: "Reviewer summary",
      detail: verdict.summary
    });
  }
  for (const comment of verdict?.comments ?? []) {
    const detail = comment.text ?? [comment.title, comment.rationale].filter(Boolean).join(": ");
    if (!detail) continue;
    candidates.push({
      source: "review-comment",
      title: comment.title ?? "Reviewer note",
      detail
    });
  }

  return candidates;
}

export function buildFollowupCapturePrompt(task: HarnessTask, memorySection = ""): string {
  const candidates = gatherFollowupCandidates(task);
  const candidateSection = candidates.length
    ? candidates.map((candidate, index) => `${index + 1}. **${candidate.title}** (${candidate.source})\n   ${candidate.detail}`).join("\n")
    : "- (none extracted — scan the task thread yourself)";

  return `You are on the harness \`capture_followups\` step for task **${task.title}**.

The harness extracted likely follow-up/debt candidates from the author's handoff and the latest reviewer message. Your job is judgment: file only real, actionable debt via \`tech_debt_capture\`. Skip noise, duplicates, and items already fixed.

${memorySection ? `${memorySection}\n` : ""}## Task description
${task.description}

## Extracted candidates
${candidateSection}

## Instructions

1. Load \`tech-debt-capture\` with \`read_skill\`.
2. Confirm each candidate is still valid and out of scope for the merged work.
3. File zero or more items with \`tech_debt_capture\` — precise titles and descriptions.
4. End with a short handoff listing what you filed (titles only) or explicitly state that nothing needed capture.`;
}