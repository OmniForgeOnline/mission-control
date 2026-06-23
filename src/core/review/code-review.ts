import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { repairJsonStringLiterals } from "../intake/schema.ts";
import { gitChangedFiles, gitCommitSubjects, gitDiffStat } from "../infra/git.ts";
import type { ToolId } from "../types.ts";
import { walkDir } from "../infra/walk-dir.ts";
import type { HarnessTask, ReviewState } from "../types.ts";
import { resolveComparisonBaseBranch, type PostTurnGitState, type PreparedWorkspace } from "../worktrees/worktrees.ts";

export interface ReviewFinding {
  file_path?: string;
  start_line?: number;
  end_line?: number;
  severity?: string;
  category?: string;
  confidence?: number;
  title?: string;
  rationale?: string;
  evidence?: string;
  fix_hint?: string;
  /** Legacy string comment (`file:line — note`). */
  text?: string;
}

export interface ReviewVerdict {
  decision: ReviewState;
  summary: string;
  comments: ReviewFinding[];
  /** True when fenced JSON could not be parsed even after legacy string-literal repair. */
  parseFailed?: boolean;
}

export interface ReviewContext {
  workspace: {
    cwd: string;
    isRepo: boolean;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    headSha?: string;
  };
  commitSubjects: string[];
  changedFiles: string[];
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  prefetchedFiles: string;
  authorReply: string;
  checksNote: string;
  mergeRequestNote: string;
}

export interface ReviewPromptInput {
  task: HarnessTask;
  authorAgent: ToolId;
  context: ReviewContext;
  memorySection?: string;
}

const MAX_CHANGED_FILES = 40;
const MAX_PREFETCH_FILES = 10;
const MAX_BYTES_PER_FILE = 8_000;
const MAX_PREFETCH_TOTAL = 32_000;

const REVIEW_STANDARDS = `## Review standards

You are a senior engineer reviewing the author's work. The harness has already checked out their branch in the workspace above and attached diff summaries plus changed-file excerpts. Use that material first; read additional files in cwd only when you need surrounding context.

Focus findings on **changed lines** in the diff. Use the worktree to validate integration impact, test claims, and caller/callee relationships.

### Do not comment on

- Import/module path verification (IDEs and compilers catch these)
- Syntax or type errors (build and type checkers catch these)
- Style, formatting, or naming (linters/formatters handle these)
- Generic suggestions without concrete evidence ("consider adding error handling")
- Logging/debug statements unless sensitive data (tokens, PII, secrets) is logged
- Theoretical edge cases that assume broken system invariants without diff evidence

### Distinguish bugs from improvements

Flag as bugs: removals that break functionality, data loss, regressions, control-flow errors (unreachable code, double HTTP responses, missing return after response).

Do not flag as bugs: new error handling, defensive checks, logging, or fallback logic.

### Severity (only report confidence ≥ 0.85)

- CRITICAL: SQL injection, auth bypass, data loss, system crash, feature breakage
- HIGH: race conditions, memory leaks, breaking API changes, significant regressions
- MEDIUM: logic errors, missing validation, measurable performance issues
- LOW: minor edge cases with evident code improvement (use sparingly)

### Evidence rules

- Each finding must quote verbatim evidence from the diff or a changed-file excerpt above.
- Comment only on lines present in the diff.
- If you cannot point to exact evidence, skip the finding.
- Cross-check the author's handoff and task description, but do not approve without reading the attached diff.`;

const OUTPUT_SCHEMA = `## Output format

Reply with a fenced JSON block first, then a brief prose explanation.

\`\`\`json
{
  "decision": "approve" | "request_changes" | "comment",
  "summary": "<one sentence overall assessment>",
  "comments": [
    {
      "file_path": "path/from/repo/root",
      "start_line": 0,
      "end_line": 0,
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "BUG|SECURITY|PERFORMANCE|ARCHITECTURE",
      "confidence": 0.95,
      "title": "short issue title",
      "rationale": "specific impact in plain language",
      "evidence": "verbatim snippet from the diff",
      "fix_hint": "optional concrete fix"
    }
  ]
}
\`\`\`

Decision rules:
- \`approve\`: no actionable issues and an empty \`comments\` array
- \`request_changes\`: any finding, code smell, improvement, or bug the author should address, regardless of severity
- \`comment\`: avoid this for code-review loops; if you include comments, the harness sends the task back to the author

Only include comments with confidence ≥ 0.85 and verbatim diff evidence.
- Escape newlines inside JSON string values as \\n (raw line breaks inside \`evidence\` break parsing).

Do not modify files, commit, or push. Reviewers never change the workspace.`;

async function readFileExcerpt(filePath: string, maxBytes: number): Promise<string> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return "[not a file]";
    if (info.size > maxBytes * 4) return `[file too large: ${info.size} bytes]`;
    const content = await readFile(filePath, "utf8");
    if (content.length > maxBytes) return `${content.slice(0, maxBytes)}\n[truncated]`;
    return content;
  } catch {
    return "[unreadable]";
  }
}

async function listScratchFiles(cwd: string, maxEntries = 30): Promise<string[]> {
  return walkDir(cwd, {
    skipDirs: new Set([".git", "node_modules"]),
    maxDepth: 3,
    maxFiles: maxEntries,
    relativePaths: true,
    sortEntries: true
  });
}

async function prefetchChangedFiles(cwd: string, changedFiles: string[]): Promise<string> {
  const blocks: string[] = [];
  let total = 0;

  for (const file of changedFiles.slice(0, MAX_PREFETCH_FILES)) {
    const excerpt = await readFileExcerpt(path.join(cwd, file), MAX_BYTES_PER_FILE);
    const block = `### ${file}\n\`\`\`\n${excerpt}\n\`\`\``;
    if (total + block.length > MAX_PREFETCH_TOTAL) {
      blocks.push("[additional changed files omitted — read them in cwd if needed]");
      break;
    }
    blocks.push(block);
    total += block.length;
  }

  return blocks.length ? blocks.join("\n\n") : "(no readable changed files)";
}

function checksNoteFor(task: HarnessTask): string {
  if (task.lastCheckFailure?.trim()) {
    return `Mechanical checks last failed:\n${task.lastCheckFailure.trim()}`;
  }
  return "Mechanical checks passed before this review (workflow advanced past checks).";
}

function mergeRequestNoteFor(task: HarnessTask): string {
  if (!task.mergeRequest) return "";
  const label = task.mergeRequest.provider === "github" ? "PR" : "MR";
  return `Open ${label} [#${task.mergeRequest.number}](${task.mergeRequest.url})`;
}

export async function gatherReviewContext(options: {
  task: HarnessTask;
  workspace: PreparedWorkspace;
  gitState: PostTurnGitState | null;
  authorReply: string;
}): Promise<ReviewContext> {
  const { task, workspace, gitState, authorReply } = options;
  const base: ReviewContext = {
    workspace: {
      cwd: workspace.cwd,
      isRepo: workspace.isRepo,
      ...(workspace.repoPath !== undefined ? { repoPath: workspace.repoPath } : {}),
      ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
      ...(gitState?.headSha !== undefined ? { headSha: gitState.headSha } : {})
    },
    commitSubjects: [],
    changedFiles: [],
    diffStat: "",
    diff: gitState?.diff ?? "",
    diffTruncated: Boolean(gitState?.diff?.includes("[diff truncated]")),
    prefetchedFiles: "",
    authorReply,
    checksNote: checksNoteFor(task),
    mergeRequestNote: mergeRequestNoteFor(task)
  };

  if (!workspace.isRepo) {
    const scratchFiles = await listScratchFiles(workspace.cwd);
    base.changedFiles = scratchFiles;
    base.prefetchedFiles = await prefetchChangedFiles(workspace.cwd, scratchFiles);
    return base;
  }

  const baseBranch = workspace.repoPath ? await resolveComparisonBaseBranch(workspace.repoPath) : "main";
  base.workspace.baseBranch = baseBranch;

  base.commitSubjects = await gitCommitSubjects(workspace.cwd, baseBranch);
  base.changedFiles = await gitChangedFiles(workspace.cwd, baseBranch, MAX_CHANGED_FILES);
  base.diffStat = await gitDiffStat(workspace.cwd, baseBranch, 2000);

  base.prefetchedFiles = await prefetchChangedFiles(workspace.cwd, base.changedFiles);
  return base;
}

function formatWorkspaceSection(context: ReviewContext): string {
  const { workspace } = context;
  if (!workspace.isRepo) {
    return `## Workspace (author scratch directory)

The harness prepared the author's working directory for this review. You run inside it with read-only intent.

- Workspace cwd: ${workspace.cwd}
- Changed files: ${context.changedFiles.length ? context.changedFiles.map((f) => `- ${f}`).join("\n") : "- (none listed)"}

Read files in cwd when the excerpts below are not enough. Do not modify files.`;
  }

  return `## Workspace (author branch checked out)

The harness reused the author's isolated git worktree on their pushed branch. You run inside it with read-only intent.

- Workspace cwd: ${workspace.cwd}
- Destination repo: ${workspace.repoPath ?? "(unknown)"}
- Branch: ${workspace.branch ?? "(unknown)"}
- Base branch: ${workspace.baseBranch ?? "main"}
- HEAD: ${workspace.headSha ?? "(unknown)"}
${context.mergeRequestNote ? `- Merge request: ${context.mergeRequestNote}` : ""}

The diff and file excerpts below were gathered programmatically from this checkout. Read additional files in cwd only when you need surrounding context. Do not modify files, commit, or push.`;
}

export function buildReviewerPrompt(input: ReviewPromptInput): string {
  const { task, authorAgent, context, memorySection = "" } = input;
  const commitSection = context.commitSubjects.length
    ? context.commitSubjects.map((subject) => `- ${subject}`).join("\n")
    : "- (none)";
  const changedFilesSection = context.changedFiles.length
    ? context.changedFiles.map((file) => `- ${file}`).join("\n")
    : "- (none)";

  return `You are the *reviewer* for a harness task. The author agent (${authorAgent}) finished their turn and the harness prepared this review context for you.

The full \`code-review\` rubric is inlined below — do not depend on \`read_skill\` for it.

${memorySection ? `${memorySection}\n` : ""}${formatWorkspaceSection(context)}

## Task title
${task.title}

## Task description
${task.description}

## Author's final message
${context.authorReply || "(no final message provided)"}

## Checks
${context.checksNote}

## Commits on branch
${commitSection}

## Changed files
${changedFilesSection}

## Diff stat
${context.diffStat || "(no diff stat)"}

## Diff against base branch
${context.diff || "(no diff captured)"}${context.diffTruncated ? "\n\n[diff truncated — use changed-file excerpts and cwd reads for full context]" : ""}

## Changed-file excerpts
${context.prefetchedFiles}

${REVIEW_STANDARDS}

${OUTPUT_SCHEMA}`;
}

function parseStructuredComment(raw: unknown): ReviewFinding | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { text: trimmed } : null;
  }
  if (!raw || typeof raw !== "object") return null;

  const entry = raw as Record<string, unknown>;
  const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
  const rationale = typeof entry["rationale"] === "string" ? entry["rationale"].trim() : "";
  const evidence = typeof entry["evidence"] === "string" ? entry["evidence"].trim() : "";
  const text = typeof entry["text"] === "string" ? entry["text"].trim() : "";

  if (!title && !rationale && !evidence && !text) return null;

  return {
    ...(typeof entry["file_path"] === "string" ? { file_path: entry["file_path"] } : {}),
    ...(typeof entry["start_line"] === "number" ? { start_line: entry["start_line"] } : {}),
    ...(typeof entry["end_line"] === "number" ? { end_line: entry["end_line"] } : {}),
    ...(typeof entry["severity"] === "string" ? { severity: entry["severity"] } : {}),
    ...(typeof entry["category"] === "string" ? { category: entry["category"] } : {}),
    ...(typeof entry["confidence"] === "number" ? { confidence: entry["confidence"] } : {}),
    ...(title ? { title } : {}),
    ...(rationale ? { rationale } : {}),
    ...(evidence ? { evidence } : {}),
    ...(typeof entry["fix_hint"] === "string" ? { fix_hint: entry["fix_hint"] } : {}),
    ...(text ? { text } : {})
  };
}

export function formatReviewFinding(finding: ReviewFinding): string {
  if (finding.text) return finding.text;

  const location =
    finding.file_path && finding.start_line
      ? `${finding.file_path}:${finding.start_line}${finding.end_line && finding.end_line !== finding.start_line ? `-${finding.end_line}` : ""}`
      : finding.file_path ?? "unknown";
  const severity = finding.severity ? `[${finding.severity}] ` : "";
  const title = finding.title ?? "Issue";
  const rationale = finding.rationale ? `: ${finding.rationale}` : "";
  const evidence = finding.evidence ? ` (evidence: ${finding.evidence})` : "";
  const fix = finding.fix_hint ? ` — fix: ${finding.fix_hint}` : "";

  return `${severity}${location} — ${title}${rationale}${evidence}${fix}`;
}

export function formatReviewRemediation(verdict: ReviewVerdict): string {
  const details =
    verdict.comments.length > 0
      ? verdict.comments.map((comment) => `- ${formatReviewFinding(comment)}`).join("\n")
      : "- (see summary)";

  return `Reviewer requested changes:\n\n${verdict.summary}\n\nFindings:\n${details}\n\nFix the issues, commit, and push again.`;
}

function parseReviewerVerdictJson(candidate: string): { json: unknown } | { error: string } {
  const text = candidate.trim();
  try {
    return { json: JSON.parse(text) };
  } catch (firstError) {
    try {
      return { json: JSON.parse(repairJsonStringLiterals(text)) };
    } catch {
      const message = firstError instanceof Error ? firstError.message : "Invalid JSON";
      return { error: message };
    }
  }
}

function isParsedReviewerVerdictObject(
  value: unknown
): value is {
  decision?: unknown;
  summary?: unknown;
  comments?: unknown;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verdictFromParsedJson(json: {
  decision?: unknown;
  summary?: unknown;
  comments?: unknown;
}): ReviewVerdict {
  const decisionRaw = String(json.decision ?? "comment").toLowerCase();
  const comments = Array.isArray(json.comments)
    ? json.comments
        .map((entry) => parseStructuredComment(entry))
        .filter((entry): entry is ReviewFinding => entry !== null)
    : [];
  const decision: ReviewState =
    comments.length > 0
      ? "changes_requested"
      : decisionRaw === "request_changes" || decisionRaw === "comment"
        ? "changes_requested"
        : decisionRaw === "approve" || decisionRaw === "approved"
          ? "approved"
          : "none";
  const summary = typeof json.summary === "string" ? json.summary : "";
  return { decision, summary, comments };
}

function extractReviewerStringField(candidate: string, field: "decision" | "summary"): string {
  const match = candidate.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i"));
  if (!match?.[1]) return "";
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function fallbackVerdictFromMalformedJson(candidate: string): ReviewVerdict | null {
  const decisionRaw = extractReviewerStringField(candidate, "decision").toLowerCase();
  if (!decisionRaw) return null;
  const hasComments = /"comments"\s*:\s*\[\s*\{/i.test(candidate);
  const decision: ReviewState =
    hasComments
      ? "changes_requested"
      : decisionRaw === "request_changes" || decisionRaw === "comment"
        ? "changes_requested"
        : decisionRaw === "approve" || decisionRaw === "approved"
          ? "approved"
          : "none";
  if (decision === "none") return null;
  return {
    decision,
    summary: extractReviewerStringField(candidate, "summary"),
    comments: []
  };
}

export function parseReviewerVerdict(reply: string): ReviewVerdict {
  const fence = reply.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fence?.[1] ?? reply;
  const parsed = parseReviewerVerdictJson(candidate);
  if ("error" in parsed) {
    const fallback = fallbackVerdictFromMalformedJson(candidate);
    if (fallback) return fallback;
    return { decision: "none", summary: reply.slice(0, 200), comments: [], parseFailed: true };
  }
  if (!isParsedReviewerVerdictObject(parsed.json)) {
    return { decision: "none", summary: reply.slice(0, 200), comments: [], parseFailed: true };
  }
  return verdictFromParsedJson(parsed.json);
}
