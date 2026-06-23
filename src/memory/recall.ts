import path from "node:path";

import type { HarnessTask } from "../core/types.ts";
import { searchMemoryPages, type MemorySearchResult } from "./store.ts";

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 2;
const MAX_QUERY_LENGTH = 3000;
const MAX_SNIPPET_LENGTH = 400;
const GENERIC_RECALL_TERMS = new Set([
  "skill",
  "fix",
  "task",
  "harness",
  "update",
  "add",
  "quality",
  "gate",
  "server",
  "rule",
  "hook",
  "code",
  "feature",
  "bug",
  "bugfix"
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with"
]);

function recallTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9/_-]+/)) {
    const term = raw.trim();
    if (term.length < 3 || STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Build a search query from task context (title, description, targets, operator notes). */
export function buildMemoryRecallQuery(task: HarnessTask, extra?: string): string {
  const operatorNotes = (task.messages ?? [])
    .filter((message) => message.author === "operator")
    .map((message) => message.body);

  const parts = [
    task.title,
    task.description,
    ...task.targets.flatMap((target) => [target.path, path.basename(target.path)]),
    ...operatorNotes,
    extra
  ];

  return parts
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .slice(0, MAX_QUERY_LENGTH);
}

function matchedTermsForHit(hit: MemorySearchResult, terms: string[]): string[] {
  const slugTitle = `${hit.slug} ${hit.title}`.toLowerCase();
  const body = `${hit.tags.join(" ")} ${hit.snippet}`.toLowerCase();
  return terms.filter((term) => slugTitle.includes(term) || body.includes(term));
}

/** Weight slug/title matches higher and ignore single generic-term overlaps. */
function computeRecallScore(hit: MemorySearchResult, terms: string[]): number {
  const uniqueTerms = [...new Set(terms)];
  const slugTitle = `${hit.slug} ${hit.title}`.toLowerCase();
  const body = `${hit.tags.join(" ")} ${hit.snippet}`.toLowerCase();
  const matched = matchedTermsForHit(hit, uniqueTerms);
  if (!matched.length) return 0;

  const score = uniqueTerms.reduce((sum, term) => {
    if (slugTitle.includes(term)) return sum + 2;
    if (body.includes(term)) return sum + 1;
    return sum;
  }, 0);

  const slugTitleMatches = matched.filter((term) => slugTitle.includes(term));
  const specificSlugTitleMatches = slugTitleMatches.filter((term) => !GENERIC_RECALL_TERMS.has(term));
  if (score < DEFAULT_MIN_SCORE) return 0;
  if (matched.length < 2 && specificSlugTitleMatches.length === 0) return 0;

  return score;
}

export async function recallMemoryForTask(
  root: string,
  task: HarnessTask,
  options?: { limit?: number; minScore?: number; extraQuery?: string }
): Promise<MemorySearchResult[]> {
  if (!task.projectId) return [];
  const query = buildMemoryRecallQuery(task, options?.extraQuery);
  const terms = recallTerms(query);
  if (!terms.length) return [];

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const hits = await searchMemoryPages(root, task.projectId, terms.join(" "));
  return hits
    .map((hit) => ({ ...hit, score: computeRecallScore(hit, terms) }))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** Markdown block injected into agent prompts when recall finds matching wiki pages. */
export function formatMemoryRecallSection(hits: MemorySearchResult[]): string {
  if (!hits.length) return "";

  const entries = hits
    .map((hit) => {
      const snippet =
        hit.snippet.length > MAX_SNIPPET_LENGTH
          ? `${hit.snippet.slice(0, MAX_SNIPPET_LENGTH)}...`
          : hit.snippet;
      const tags = hit.tags.length ? ` · tags: ${hit.tags.join(", ")}` : "";
      return `### ${hit.slug} (${hit.title})
type: ${hit.type}${tags}

${snippet}`;
    })
    .join("\n\n");

  return `## Recalled memory (harness wiki)

The harness matched these durable pages from \`data/memory/pages/\` to this task. Treat them as authoritative for this user's projects, preferences, corrections, and prior analysis. Use \`gbrain_read(slug)\` when you need the full page.

${entries}`;
}

export async function buildMemoryRecallSection(
  root: string,
  task: HarnessTask,
  options?: { limit?: number; minScore?: number; extraQuery?: string }
): Promise<string> {
  const hits = await recallMemoryForTask(root, task, options);
  return formatMemoryRecallSection(hits);
}
