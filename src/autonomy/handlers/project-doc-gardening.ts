import path from "node:path";

import { runAutonomyAgentTurn } from "../agent-run.ts";
import { collectMarkdown, readOptionalFile } from "./shared.ts";
import { getMemoryPage, listMemoryPages } from "../../memory/store.ts";
import type { ProjectRecord } from "../../core/projects/registry.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

const MAX_DOC_FILES = 24;
const MAX_MEMORY_PAGES = 24;
const EXCERPT_CHARS = 1500;

export function projectDocGardeningTaskId(projectId: string): string {
  return `autonomy:project:${projectId}:doc-gardening`;
}

/**
 * Build doc-gardening context from a project's *own* documentation — markdown
 * under its repo (README, docs/, AGENTS.md, …) — plus its per-project memory
 * pages. No kernel scanning: that is harness-specific and handled by the global
 * guidance sweep.
 */
export async function buildProjectDocGardeningContext(
  root: string,
  project: ProjectRecord
): Promise<string> {
  const docFiles = (await collectMarkdown(project.repoPath)).slice(0, MAX_DOC_FILES);
  const docSections: string[] = [];
  for (const file of docFiles) {
    const content = await readOptionalFile(file);
    if (!content) continue;
    const relative = path.relative(project.repoPath, file);
    const excerpt = content.trim().slice(0, EXCERPT_CHARS);
    docSections.push(`### ${relative}\n\n${excerpt}${content.length > EXCERPT_CHARS ? "\n\n…(truncated)" : ""}`);
  }

  const pages = (await listMemoryPages(root, project.id)).slice(0, MAX_MEMORY_PAGES);
  const memorySections: string[] = [];
  for (const summary of pages) {
    const page = await getMemoryPage(root, project.id, summary.slug);
    const excerpt = page.content.trim().slice(0, EXCERPT_CHARS);
    memorySections.push(
      `### memory: ${page.title} (${page.slug})\n\n${excerpt}${page.content.length > EXCERPT_CHARS ? "\n\n…(truncated)" : ""}`
    );
  }

  return [
    `Project: ${project.name} (${project.repoPath})`,
    `Repo docs scanned: ${docSections.length}; memory pages scanned: ${memorySections.length}`,
    "",
    "Use filesystem tools and MCP to verify references against the project's current code.",
    "",
    "## Repo documentation",
    docSections.length ? docSections.join("\n\n") : "- none",
    "",
    "## Project memory pages",
    memorySections.length ? memorySections.join("\n\n") : "- none"
  ].join("\n");
}

export function buildProjectDocGardeningPrompt(project: ProjectRecord, context: string): string {
  return `You are the documentation-gardening agent for the project "${project.name}" (${project.repoPath}) on a scheduled autonomy run.

Find documentation drift in this project's own docs and memory — broken file references, outdated commands, contradictions with the current code, and guidance that no longer matches how the project actually works.

## Mandate

1. Review the excerpts below; verify suspect references with filesystem reads and MCP (\`gbrain_search\`, \`read_task\`, \`read_run\`).
2. For doc-file fixes that need an implementation pass, capture them with \`tech_debt_capture(projectId: "${project.id}")\` so the project's tech-debt sweep can queue a task.
3. For the project's own memory wiki pages, file corrections with \`gbrain_propose(projectId: "${project.id}")\`.
4. Do NOT edit project files directly. Do NOT use \`propose_rule\`, \`propose_skill\`, or \`propose_hook\` — those target the harness kernel, not this project.
5. Prefer concrete, actionable findings over vague "could be clearer" notes.

## Documentation excerpts

${context}

## Output

End with a short operator handoff: what you checked, findings count, and what you captured for ${project.name}. If the docs are current, say so explicitly.`;
}

export async function runProjectDocGardening(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const result = await runAutonomyAgentTurn(root, {
    taskId: projectDocGardeningTaskId(project.id),
    taskTitle: `Doc gardening: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/doc-gardening.json`,
    skipSummary: `Doc gardening skipped for ${project.name}: already running.`,
    completedSummary: (turnNumber, proposalsCreated) =>
      `Doc gardening turn ${turnNumber} for ${project.name}; captured ${proposalsCreated} item(s).`,
    blockedSummary: (reason) => `Doc gardening blocked for ${project.name}: ${reason}`,
    buildContext: () => buildProjectDocGardeningContext(root, project),
    buildPrompt: (ctx) => buildProjectDocGardeningPrompt(project, ctx)
  });

  return {
    jobId: "doc-gardening",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
