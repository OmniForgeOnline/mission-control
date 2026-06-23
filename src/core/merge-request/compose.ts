import { gitCommitSubjects, gitDiffStat } from "../infra/git.ts";
import type { HarnessTask } from "../types.ts";
import type { AgentRunner } from "../../runners/types.ts";
import {
  appendVisualReviewSection,
  buildVisualReviewSection,
  detectCommittedScreenshots,
  isUiInvolvedWorkflow
} from "./screenshots.ts";
import { resolveRemoteRepo } from "./resolve.ts";

export interface MergeRequestComposeOverrides {
  title?: string;
  description?: string;
}

export interface MergeRequestComposeInput {
  task: HarnessTask;
  repoPath: string;
  baseBranch: string;
  sourceBranch: string;
  overrides?: MergeRequestComposeOverrides;
}

export interface MergeRequestComposeResult {
  title: string;
  description: string;
  usedFallback: boolean;
}

export interface HandoffSections {
  pushed: string;
  changed: string;
  verified: string;
  open: string;
  watch: string;
}

export interface GatheredComposeContext {
  ticketTitle: string;
  ticketDescription: string;
  goalExcerpt: string;
  planExcerpt: string;
  acceptanceExcerpt: string;
  commitSubjects: string[];
  diffStat: string;
  handoff: HandoffSections;
  taskRef: string;
}

const HANDOFF_MARKERS = ["Pushed", "Changed", "Verified", "Open", "Watch", "Next"] as const;

function extractMarkdownSection(description: string, heading: string): string {
  const match = description.match(new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, "i"));
  if (!match?.[1]) return "";
  return match[1].trim().slice(0, 2000);
}

function extractPlanExcerpt(description: string): string {
  return extractMarkdownSection(description, "Plan");
}

export function extractHandoffSections(body: string): HandoffSections {
  const empty: HandoffSections = { pushed: "", changed: "", verified: "", open: "", watch: "" };
  if (!body.trim()) return empty;

  const markerPattern = new RegExp(`\\*\\*(${HANDOFF_MARKERS.join("|")})\\.\\*\\*`, "g");
  const matches = [...body.matchAll(markerPattern)];
  if (!matches.length) return empty;

  const firstMarker = matches[0]!;
  const structured = body.slice(firstMarker.index ?? 0);
  const structuredMatches = [...structured.matchAll(markerPattern)];
  const sections: HandoffSections = { ...empty };

  for (let i = 0; i < structuredMatches.length; i += 1) {
    const match = structuredMatches[i]!;
    const marker = match[1] as (typeof HANDOFF_MARKERS)[number];
    const start = (match.index ?? 0) + match[0].length;
    const end =
      i + 1 < structuredMatches.length ? structuredMatches[i + 1]!.index ?? structured.length : structured.length;
    const value = structured.slice(start, end).trim();
    if (marker === "Pushed") sections.pushed = value;
    if (marker === "Changed") sections.changed = value;
    if (marker === "Verified") sections.verified = value;
    if (marker === "Open") sections.open = value;
    if (marker === "Watch") sections.watch = value;
  }

  return sections;
}

function latestAgentHandoff(messages: HarnessTask["messages"]): HandoffSections {
  const lastAgent = (messages ?? []).filter((m) => m.author === "agent").at(-1)?.body?.trim() ?? "";
  return extractHandoffSections(lastAgent);
}

function taskReference(task: HarnessTask): string {
  return `task://${task.id}`;
}

export async function gatherComposeInputs(input: MergeRequestComposeInput): Promise<GatheredComposeContext> {
  const { task, repoPath, baseBranch } = input;
  const cwd = task.workspacePath ?? repoPath;
  const commitSubjects = await gitCommitSubjects(cwd, baseBranch);
  const diffStat = await gitDiffStat(cwd, baseBranch, 1500);
  return {
    ticketTitle: task.title,
    ticketDescription: task.description,
    goalExcerpt: extractMarkdownSection(task.description, "Goal"),
    planExcerpt: extractPlanExcerpt(task.description),
    acceptanceExcerpt: extractMarkdownSection(task.description, "Acceptance criteria"),
    commitSubjects,
    diffStat,
    handoff: latestAgentHandoff(task.messages),
    taskRef: taskReference(task)
  };
}

function formatHandoffForPrompt(handoff: HandoffSections): string {
  const lines = [
    handoff.pushed ? `Pushed: ${handoff.pushed}` : "",
    handoff.changed ? `Changed:\n${handoff.changed}` : "",
    handoff.verified ? `Verified: ${handoff.verified}` : "",
    handoff.open ? `Open: ${handoff.open}` : "",
    handoff.watch ? `Watch: ${handoff.watch}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function summaryFromContext(context: GatheredComposeContext): string {
  return context.goalExcerpt || context.planExcerpt.split("\n").slice(0, 3).join("\n").trim() || context.ticketTitle;
}

function whatChangedFromContext(context: GatheredComposeContext): string {
  if (context.handoff.changed) return context.handoff.changed;
  if (context.handoff.pushed) return context.handoff.pushed;
  if (context.commitSubjects.length) {
    return context.commitSubjects.map((subject) => `- ${subject}`).join("\n");
  }
  return "";
}

function reviewerNotesFromContext(context: GatheredComposeContext): string {
  const notes = [context.handoff.open, context.handoff.watch].filter((value) => value && value.toLowerCase() !== "none");
  return notes.join("\n\n");
}

function inferConventionalTitle(title: string, context: GatheredComposeContext): string {
  const trimmed = title.trim();
  if (!trimmed) return "chore: harness change";
  if (/^(feat|fix|refactor|docs|chore|perf|test)(\([^)]+\))?:\s/i.test(trimmed)) {
    return trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed;
  }

  const signals = `${context.goalExcerpt}\n${context.ticketDescription}\n${trimmed}`.toLowerCase();
  let prefix = "feat:";
  if (/\b(bug|fix|broken|regression|defect)\b/.test(signals)) prefix = "fix:";
  else if (/\brefactor/.test(signals)) prefix = "refactor:";
  else if (/\b(doc|documentation|readme)\b/.test(signals)) prefix = "docs:";
  else if (/\b(test|coverage|spec)\b/.test(signals)) prefix = "test:";
  else if (/\b(perf|performance|latency|memory)\b/.test(signals)) prefix = "perf:";
  else if (/\b(chore|deps|dependency|config|ci)\b/.test(signals)) prefix = "chore:";

  const combined = `${prefix} ${trimmed}`;
  return combined.length > 100 ? `${combined.slice(0, 97)}...` : combined;
}

function formatKeyChangesBullets(context: GatheredComposeContext): string {
  const raw = whatChangedFromContext(context);
  if (!raw) return "";

  const bullets = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("- ")) return line;
      if (line.startsWith("* ")) return `- ${line.slice(2)}`;
      return `- ${line}`;
    });

  return bullets.slice(0, 5).join("\n");
}

function formatImpactSection(context: GatheredComposeContext): string {
  const parts: string[] = [];
  const summary = summaryFromContext(context).split("\n")[0]?.trim();
  if (summary && summary !== context.ticketTitle.trim()) {
    parts.push(summary);
  } else if (context.acceptanceExcerpt) {
    parts.push(context.acceptanceExcerpt.split("\n")[0]?.trim() ?? "");
  }

  if (context.handoff.verified) {
    parts.push(`Verified with ${context.handoff.verified.replace(/\.$/, "")}.`);
  }

  const watch = reviewerNotesFromContext(context);
  if (watch) {
    parts.push(`Residual risks: ${watch.replace(/\n+/g, " ")}`);
  }

  return parts.filter(Boolean).join(" ");
}

function buildStructuredDescription(context: GatheredComposeContext): string {
  const overview = [context.taskRef, summaryFromContext(context)].filter(Boolean).join("\n\n");
  const keyChanges = formatKeyChangesBullets(context);
  const impact = formatImpactSection(context);

  return [
    "## Overview",
    overview,
    "",
    keyChanges ? "## Key Changes\n" + keyChanges : "",
    "",
    impact ? "## Impact\n" + impact : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function isStructuredMergeRequestMarkdown(description: string): boolean {
  const headings = [...description.matchAll(/^## (Overview|Key Changes|Impact)\s*$/gm)];
  if (headings.length !== 3) return false;
  if (headings.map((match) => match[1]).join("|") !== "Overview|Key Changes|Impact") return false;

  return headings.every((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1]!.index ?? description.length : description.length;
    return description.slice(start, end).trim().length > 0;
  });
}

export function buildComposePrompt(context: GatheredComposeContext): string {
  const handoff = formatHandoffForPrompt(context.handoff);
  return [
    "Generate a merge request title and description for a code change.",
    "Respond with strict JSON only: {\"title\":\"...\",\"description\":\"...\"}",
    "",
    `Harness ticket: ${context.taskRef}`,
    `Ticket title: ${context.ticketTitle}`,
    "",
    "Ticket description:",
    context.ticketDescription.slice(0, 4000),
    "",
    context.goalExcerpt ? `Goal:\n${context.goalExcerpt}` : "",
    "",
    context.planExcerpt ? `Plan excerpt:\n${context.planExcerpt}` : "",
    "",
    context.acceptanceExcerpt ? `Acceptance criteria:\n${context.acceptanceExcerpt}` : "",
    "",
    context.commitSubjects.length ? `Commit subjects:\n${context.commitSubjects.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    context.diffStat ? `Diff stat:\n${context.diffStat}` : "",
    "",
    handoff ? `Author handoff (structured final message):\n${handoff}` : "",
    "",
    "Title guidelines:",
    "- Concise and descriptive (under 100 characters).",
    "- Follow conventional commit prefixes: feat:, fix:, refactor:, docs:, chore:, perf:, test:.",
    "- Reflect the work, not the branch name.",
    "",
    "Description guidelines:",
    "MUST contain EXACTLY three sections in this order:",
    "1. ## Overview",
    "2. ## Key Changes",
    "3. ## Impact",
    "",
    "Each section must be separated by a blank line. Do NOT add sections before Overview or after Impact.",
    "",
    "Overview: first line is the harness ticket link, then 1-2 sentences on what and why.",
    "Key Changes: 3-5 bullet points from the author handoff and diff. Group related changes; avoid listing every file.",
    "Impact: 1-2 sentences on user-facing or system-level effects. Include verification and residual risks when relevant.",
    "",
    "Professional standards:",
    "- Under 200 words total.",
    "- Clear, technical, professional language.",
    "- Do NOT echo commit subjects, diff stats, or raw agent narration."
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFallbackMergeRequestContent(context: GatheredComposeContext): MergeRequestComposeResult {
  const title = inferConventionalTitle(context.ticketTitle, context);
  const description = buildStructuredDescription(context);

  return { title, description, usedFallback: true };
}

function parseAgentJson(body: string): { title?: string; description?: string } | null {
  const trimmed = body.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(candidate) as { title?: string; description?: string };
    if (typeof parsed.title === "string" && typeof parsed.description === "string") {
      return parsed;
    }
    return null;
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      const parsed = JSON.parse(objectMatch[0]) as { title?: string; description?: string };
      if (typeof parsed.title === "string" && typeof parsed.description === "string") {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }
}

export async function composeMergeRequestContent(
  input: MergeRequestComposeInput,
  options?: { runner?: AgentRunner }
): Promise<MergeRequestComposeResult> {
  const base = await composeBaseMergeRequestContent(input, options);
  const description = await attachVisualReview(base.description, input);
  return { ...base, description };
}

async function composeBaseMergeRequestContent(
  input: MergeRequestComposeInput,
  options?: { runner?: AgentRunner }
): Promise<MergeRequestComposeResult> {
  if (input.overrides?.title?.trim() && input.overrides?.description?.trim()) {
    return {
      title: input.overrides.title.trim(),
      description: input.overrides.description.trim(),
      usedFallback: false
    };
  }

  const context = await gatherComposeInputs(input);

  if (input.overrides?.title?.trim()) {
    const fallback = buildFallbackMergeRequestContent(context);
    return {
      title: input.overrides.title.trim(),
      description: input.overrides.description?.trim() || fallback.description,
      usedFallback: !input.overrides.description?.trim()
    };
  }

  if (options?.runner) {
    try {
      const result = await options.runner.runTurn({
        task: { ...input.task, effort: "low" },
        prompt: buildComposePrompt(context),
        cwd: input.task.workspacePath ?? input.repoPath,
        turnNumber: (input.task.turnCount ?? 0) + 1
      });
      const parsed = parseAgentJson(result.reply);
      if (parsed?.title?.trim() && parsed.description?.trim()) {
        if (!isStructuredMergeRequestMarkdown(parsed.description)) {
          const fallback = buildFallbackMergeRequestContent(context);
          return {
            title: parsed.title.trim(),
            description: fallback.description,
            usedFallback: true
          };
        }
        return {
          title: parsed.title.trim(),
          description: parsed.description.trim(),
          usedFallback: false
        };
      }
    } catch {
      /* fall through to template */
    }
  }

  return buildFallbackMergeRequestContent(context);
}

/**
 * Appends a reviewer-facing "Visual Review" section for UI-involved changes when a committed
 * screenshot artifact is reachable on the branch. Non-UI workflows and UI changes without a
 * committed screenshot are left untouched.
 */
async function attachVisualReview(description: string, input: MergeRequestComposeInput): Promise<string> {
  if (!isUiInvolvedWorkflow(input.task.workflowRun?.workflowId)) return description;
  const cwd = input.task.workspacePath ?? input.repoPath;
  const screenshots = await detectCommittedScreenshots(cwd, input.baseBranch);
  if (!screenshots.length) return description;
  const repo = await resolveRemoteRepo(input.repoPath);
  if (!repo) return description;
  return appendVisualReviewSection(description, buildVisualReviewSection(repo, input.sourceBranch, screenshots));
}
