import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, updateJsonFile, writeJsonFile } from "../core/infra/fs.ts";

import { ensureHarnessRepository } from "../core/bootstrap/repository.ts";
import { projectDir } from "../core/projects/registry.ts";
import { deriveExecution } from "../core/tasks/status.ts";
import { listRuns } from "../core/tasks/runs.ts";
import { listTasks } from "../core/tasks/tasks.ts";
import { getMemoryPage, listMemoryPages, normalizeSlug } from "./store.ts";
import { rankSearchResults, tokenize } from "./search-utils.ts";

export type MemoryIndexSourceType = "memory" | "task" | "proposal" | "run" | "run-artifact" | "file";

export interface MemoryIndexDocument {
  id: string;
  sourceType: MemoryIndexSourceType;
  title: string;
  path: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

export interface MemoryIndex {
  generatedAt: string;
  documents: MemoryIndexDocument[];
}

const INDEX_SOURCE_LABELS: Record<MemoryIndexSourceType, string> = {
  memory: "wiki page",
  task: "task",
  proposal: "proposal",
  run: "run",
  "run-artifact": "run artifact",
  file: "target file"
};

/** Human-readable breakdown of indexed document counts for autonomy summaries. */
export function summarizeMemoryIndex(index: MemoryIndex): string {
  const counts = new Map<MemoryIndexSourceType, number>();
  for (const document of index.documents) {
    counts.set(document.sourceType, (counts.get(document.sourceType) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [sourceType, count] of counts) {
    const label = INDEX_SOURCE_LABELS[sourceType];
    parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
  }

  const breakdown = parts.length ? parts.join(", ") : "no documents";
  return `${breakdown} (${index.documents.length} searchable document${index.documents.length === 1 ? "" : "s"})`;
}

export interface MemoryIndexSearchResult extends MemoryIndexDocument {
  score: number;
  snippet: string;
}

export interface BuildMemoryIndexOptions {
  homeRoot?: string;
  targetPaths?: string[];
}

interface IndexableTextFile {
  content: string;
  updatedAt: string;
}

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".ts",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);
const MAX_FILE_BYTES = 512_000;
const MAX_TARGET_FILES = 200;

function indexPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "memory-index", "documents.json");
}

function now(): string {
  return new Date().toISOString();
}

export async function buildMemoryIndex(
  root: string,
  projectId: string,
  options: BuildMemoryIndexOptions = {}
): Promise<MemoryIndex> {
  await ensureHarnessRepository(root);
  const documents: MemoryIndexDocument[] = [];

  const [pages, allTasks, runs] = await Promise.all([
    listMemoryPages(root, projectId),
    listTasks(root),
    listRuns(root, projectId)
  ]);
  const tasks = allTasks.filter((task) => task.projectId === projectId);

  for (const summary of pages) {
    const page = await getMemoryPage(root, projectId, summary.slug);
    documents.push({
      id: `memory:${page.slug}`,
      sourceType: "memory",
      title: page.title,
      path: `memory/pages/${page.slug}.md`,
      content: `${page.title}\n${page.tags.join(" ")}\n${page.type}\n${page.content}`,
      tags: page.tags,
      updatedAt: page.updatedAt
    });
  }

  for (const task of tasks) {
    documents.push({
      id: `task:${task.id}`,
      sourceType: "task",
      title: task.title,
      path: `tasks/${task.id}`,
      content: [task.title, task.description, task.source, ...task.messages.map((message) => message.body)].filter(Boolean).join("\n"),
      tags: [task.resolution ?? deriveExecution(task), task.agent],
      updatedAt: task.updatedAt
    });
  }

  for (const run of runs) {
    documents.push({
      id: `run:${run.id}`,
      sourceType: "run",
      title: run.taskTitle,
      path: `runs/${run.id}`,
      content: [run.taskTitle, run.agent, run.status, run.blockedReason, run.command].filter(Boolean).join("\n"),
      tags: [run.status, run.agent],
      updatedAt: run.completedAt ?? run.startedAt
    });

    for (const artifact of run.artifacts) {
      const artifactPath = path.join(root, "data", "runs", run.id, artifact);
      const file = await readTextFileIfIndexable(artifactPath);
      if (!file) continue;
      documents.push({
        id: `run-artifact:${run.id}:${artifact}`,
        sourceType: "run-artifact",
        title: artifact,
        path: `runs/${run.id}/${artifact}`,
        content: file.content,
        tags: [run.status, run.agent],
        updatedAt: run.completedAt ?? file.updatedAt
      });
    }
  }

  for (const filePath of await collectTargetFiles(options.targetPaths ?? [], options.homeRoot)) {
    const file = await readTextFileIfIndexable(filePath);
    if (!file) continue;
    documents.push({
      id: `file:${filePath}`,
      sourceType: "file",
      title: path.basename(filePath),
      path: filePath,
      content: file.content,
      tags: ["target"],
      updatedAt: file.updatedAt
    });
  }

  const index = { generatedAt: now(), documents };
  await writeJsonFile(indexPath(root, projectId), index);
  return index;
}

export async function searchMemoryIndex(
  root: string,
  projectId: string,
  query: string
): Promise<MemoryIndexSearchResult[]> {
  await ensureHarnessRepository(root);
  const terms = tokenize(query);
  if (!terms.length) return [];
  const index = await readJsonFile<MemoryIndex>(indexPath(root, projectId), { generatedAt: "", documents: [] });
  return rankSearchResults(index.documents, terms, {
    getHaystack: (document) => `${document.title} ${document.path} ${document.tags.join(" ")} ${document.content}`,
    getSnippetSource: (document) => document.content,
    mode: "occurrences",
    sortKey: (a, b) => a.path.localeCompare(b.path)
  });
}

/**
 * Drop a memory page's document from the persistent index so it stops matching
 * searches after the page is deleted. No-op when no index has been built yet.
 */
export async function removeMemoryDocument(root: string, projectId: string, slug: string): Promise<void> {
  await ensureHarnessRepository(root);
  const file = indexPath(root, projectId);
  try {
    await stat(file);
  } catch {
    return;
  }
  const documentId = `memory:${normalizeSlug(slug)}`;
  await updateJsonFile<MemoryIndex>(file, { generatedAt: "", documents: [] }, (index) => ({
    ...index,
    documents: index.documents.filter((document) => document.id !== documentId)
  }));
}

async function collectTargetFiles(targetPaths: string[], homeRoot?: string): Promise<string[]> {
  const files: string[] = [];
  for (const rawPath of targetPaths) {
    const target = normalizeTargetPath(rawPath, homeRoot);
    for (const filePath of await walkTarget(target)) {
      files.push(filePath);
      if (files.length >= MAX_TARGET_FILES) return files;
    }
  }
  return files;
}

function normalizeTargetPath(rawPath: string, homeRoot?: string): string {
  const resolved = path.resolve(rawPath.replace(/^@/, ""));
  if (!homeRoot) return resolved;
  const resolvedHome = path.resolve(homeRoot);
  if (resolved !== resolvedHome && !resolved.startsWith(`${resolvedHome}${path.sep}`)) {
    throw new Error(`Indexed target must stay under ${resolvedHome}`);
  }
  return resolved;
}

async function walkTarget(target: string): Promise<string[]> {
  const stats = await stat(target);
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTarget(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
    if (files.length >= MAX_TARGET_FILES) return files;
  }
  return files;
}

async function readTextFileIfIndexable(filePath: string): Promise<IndexableTextFile | undefined> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension && !TEXT_EXTENSIONS.has(extension)) return undefined;
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
  return { content: await readFile(filePath, "utf8"), updatedAt: stats.mtime.toISOString() };
}
