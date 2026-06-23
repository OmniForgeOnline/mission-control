import { healStreamedMarkdown } from "../agents/output.ts";

const PROPOSED_PLAN_BLOCK_RE = /<proposed_plan>\s*([\s\S]*?)<\/proposed_plan>/i;
const FINAL_PLAN_MARKER_RE = /(?:^|\n)FINAL_PLAN:\s*([\s\S]+)/i;
const HAS_PROPOSED_PLAN_RE = /<proposed_plan/i;
const HAS_FINAL_PLAN_RE = /^FINAL_PLAN:/im;

/** True when text contains a proposed_plan block or FINAL_PLAN marker. */
export function hasPlanMarker(text: string): boolean {
  return HAS_PROPOSED_PLAN_RE.test(text) || HAS_FINAL_PLAN_RE.test(text);
}

function stripOuterMarkdownFence(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

interface PlanExtraction {
  plan: string;
  matchIndex: number;
}

/** Locate plan body and its start index inside already-normalized text. */
function findPlanExtraction(normalized: string): PlanExtraction | null {
  const block = normalized.match(PROPOSED_PLAN_BLOCK_RE);
  if (block?.[1]?.trim()) {
    return { plan: block[1].trim(), matchIndex: block.index ?? 0 };
  }
  const marker = normalized.match(FINAL_PLAN_MARKER_RE);
  if (marker?.[1]?.trim()) {
    return { plan: stripOuterMarkdownFence(marker[1].trim()), matchIndex: marker.index ?? 0 };
  }
  return null;
}

/** Extract plan markdown from normalized agent reply text. */
export function extractPlanBody(normalized: string): string | undefined {
  return findPlanExtraction(normalized)?.plan;
}

export interface PlanContentParts {
  preamble: string;
  plan: string;
}

/** Split narrative content from an embedded plan marker block. */
export function splitPlanContent(content: string): PlanContentParts | null {
  const extraction = findPlanExtraction(content);
  if (!extraction) return null;
  return {
    preamble: content.slice(0, extraction.matchIndex).trim(),
    plan: extraction.plan
  };
}

/** Extract the final plan from a raw agent reply (applies stream markdown healing). */
export function extractFinalPlan(reply: string): string | undefined {
  return extractPlanBody(healStreamedMarkdown(reply));
}