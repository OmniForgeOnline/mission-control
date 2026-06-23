import { isProposalTicket } from "../core/proposals/ticket.ts";
import type { HarnessRun, HarnessTask } from "../core/types.ts";
import { captureMemoryPage, getMemoryPage, searchMemoryPages, type MemoryPage } from "./store.ts";

const DEDUP_SCORE_THRESHOLD = 3;
const MAX_LESSON_LENGTH = 1000;
const MAX_OUTCOME_LENGTH = 1200;

/** Stable slug for a project's auto-captured context/outcome page. */
const PROJECT_OVERVIEW_SLUG = "overview";

const SYNTHETIC_TITLE_PREFIXES = [
  "Quality gate:",
  "Tech debt:",
  "Skill:",
  "Rule:",
  "Hook:",
  "Harness self-improvement"
];

/** Patterns that indicate an explicit, durable lesson. */
export const LESSON_PATTERNS = [
  /\bI learned\b/i,
  /\bkey insight\b/i,
  /\bnote for future\b/i,
  /\bgoing forward\b/i,
  /\bimportant (?:to remember|pattern|rule)\b/i,
  /\bthis (?:project|repo|codebase) (?:always|requires|prefers)\b/i
];

const OPERATOR_CAPTURE_PATTERNS = [
  /\b(prefer|always|never|don't|do not|instead|remember|correction|going forward|from now on)\b/i,
  /\b(use .+ (?:not|over))\b/i,
  /\b(should always|must never|please always)\b/i
];

const OPERATOR_SKIP = /^(yes|no|ok|okay|lgtm|approve|approved|run|continue|go ahead|ship it|thanks)\b/i;

const REVIEWER_REPLY = /\{"decision"\s*:\s*"(?:approve|changes_requested)"/i;
const REVIEW_HANDOFF = /^(?:Reviewing|Reviewed commit)\b/m;

function slugifyForMemory(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}

export function shouldAutoCaptureTask(task: HarnessTask): boolean {
  if (task.source === "autonomy") return false;
  if (isProposalTicket(task)) return false;
  if (SYNTHETIC_TITLE_PREFIXES.some((prefix) => task.title.startsWith(prefix))) return false;
  return true;
}

function isEphemeralCompletionReply(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return true;
  if (REVIEWER_REPLY.test(trimmed)) return true;
  if (REVIEW_HANDOFF.test(trimmed)) return true;
  return false;
}

function extractParagraph(text: string, matchIndex: number): string {
  const start = text.lastIndexOf("\n\n", matchIndex);
  const end = text.indexOf("\n\n", matchIndex);
  const paragraph = text.slice(start === -1 ? 0 : start + 2, end === -1 ? undefined : end);
  return paragraph.length > MAX_LESSON_LENGTH
    ? `${paragraph.slice(0, MAX_LESSON_LENGTH)}...`
    : paragraph;
}

function extractTopicKey(reply: string, matchIndex: number): string {
  const sentenceStart = reply.lastIndexOf(". ", matchIndex);
  const sentenceEnd = reply.indexOf(". ", matchIndex);
  const sentence = reply
    .slice(sentenceStart === -1 ? 0 : sentenceStart + 2, sentenceEnd === -1 ? undefined : sentenceEnd + 1)
    .trim()
    .toLowerCase();
  return sentence.slice(0, 80);
}

function withAttribution(content: string, source: string): string {
  return `${content.trim()}\n\n_Auto-captured ${new Date().toISOString()} from ${source}_`;
}

async function autoCaptureMemoryPage(
  root: string,
  projectId: string,
  input: {
    slug: string;
    type: string;
    title: string;
    tags?: string[];
    content: string;
    source: string;
    dedupeQuery?: string;
    dedupeThreshold?: number;
    append?: boolean;
  }
): Promise<MemoryPage | null> {
  const content = input.content.trim();
  if (!content) return null;

  if (!input.append) {
    const dedupeQuery = input.dedupeQuery ?? content.slice(0, 120);
    if (dedupeQuery.trim()) {
      const existing = await searchMemoryPages(root, projectId, dedupeQuery);
      const threshold = input.dedupeThreshold ?? DEDUP_SCORE_THRESHOLD;
      if (existing.some((hit) => hit.score >= threshold)) {
        return null;
      }
    }
  }

  let body = content;
  if (input.append) {
    try {
      const page = await getMemoryPage(root, projectId, input.slug);
      if (page.content.includes(content.slice(0, Math.min(80, content.length)))) {
        return null;
      }
      body = `${page.content.trim()}\n\n---\n\n${content}`;
    } catch {
      /* create fresh page */
    }
  }

  return captureMemoryPage(root, projectId, {
    slug: input.slug,
    type: input.type,
    title: input.title,
    tags: input.tags ?? ["auto"],
    content: withAttribution(body, input.source)
  });
}

export async function captureLessonFromReply(
  root: string,
  task: HarnessTask,
  run: HarnessRun,
  reply: string
): Promise<MemoryPage | null> {
  if (!task.projectId || !reply.trim()) return null;

  const match = LESSON_PATTERNS.find((pattern) => pattern.test(reply));
  if (!match) return null;

  const matchIndex = reply.search(match);
  const topicKey = extractTopicKey(reply, matchIndex);
  const content = extractParagraph(reply, matchIndex);
  if (!content.trim()) return null;

  const title = content.split(/[.!?]/)[0]?.trim().slice(0, 80) || "Auto-captured lesson";
  const slug = `lessons/${slugifyForMemory(title)}`;

  return autoCaptureMemoryPage(root, task.projectId, {
    slug,
    type: "lesson",
    title,
    tags: ["auto", "lesson"],
    content,
    source: `task "${task.title}" run ${run.id}`,
    dedupeQuery: topicKey || content.slice(0, 80),
    dedupeThreshold: DEDUP_SCORE_THRESHOLD
  });
}

export async function captureFromOperatorMessage(
  root: string,
  task: HarnessTask,
  body: string
): Promise<MemoryPage | null> {
  if (!task.projectId) return null;
  const trimmed = body.trim();
  if (trimmed.length < 40 || OPERATOR_SKIP.test(trimmed)) return null;
  if (!OPERATOR_CAPTURE_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;

  return autoCaptureMemoryPage(root, task.projectId, {
    slug: `corrections/${slugifyForMemory(task.title)}`,
    type: "correction",
    title: `Correction: ${task.title}`,
    tags: ["auto", "correction"],
    content: trimmed,
    source: `operator on task ${task.id}`,
    dedupeQuery: trimmed.slice(0, 80),
    append: true
  });
}

export async function captureProjectContextFromTask(root: string, task: HarnessTask): Promise<MemoryPage | null> {
  if (!task.projectId || !shouldAutoCaptureTask(task)) return null;

  try {
    await getMemoryPage(root, task.projectId, PROJECT_OVERVIEW_SLUG);
    return null;
  } catch {
    const description = task.description.trim().slice(0, 1500);
    if (!description) return null;

    return autoCaptureMemoryPage(root, task.projectId, {
      slug: PROJECT_OVERVIEW_SLUG,
      type: "project",
      title: "Project overview",
      tags: ["auto", "project"],
      content: `## Context\n\nReferenced by task **${task.title}**.\n\n${description}`,
      source: `task ${task.id} created`,
      dedupeQuery: PROJECT_OVERVIEW_SLUG,
      dedupeThreshold: 1
    });
  }
}

export async function captureTaskCompletion(
  root: string,
  task: HarnessTask,
  finalReply: string
): Promise<MemoryPage | null> {
  if (!task.projectId || !shouldAutoCaptureTask(task)) return null;
  if (isEphemeralCompletionReply(finalReply)) return null;

  const summary = finalReply.trim().slice(0, MAX_OUTCOME_LENGTH);
  if (summary.length < 80) return null;

  return autoCaptureMemoryPage(root, task.projectId, {
    slug: PROJECT_OVERVIEW_SLUG,
    type: "project",
    title: "Project overview",
    tags: ["auto", "outcome"],
    content: `## Completed: ${task.title}\n\n${summary}`,
    source: `task ${task.id} completed`,
    dedupeQuery: summary.slice(0, 100),
    append: true
  });
}
