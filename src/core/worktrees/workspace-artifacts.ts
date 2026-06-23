import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { walkDir } from "../infra/walk-dir.ts";
import { defaultBaseBranch, type PreparedWorkspace } from "./worktrees.ts";

export interface WorkspaceArtifacts {
  files: string[];
  markdownLinks: string[];
  headings: string[];
  wordCount: number;
  diffStat: string;
  changedFiles: string[];
  fileExcerpts: string;
}

const MAX_FILES = 30;
const MAX_LINKS = 40;
const MAX_HEADINGS = 20;
const MAX_EXCERPT_FILES = 8;
const MAX_BYTES_PER_FILE = 6_000;

async function safeRead(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_BYTES_PER_FILE * 4) return "";
    const content = await readFile(filePath, "utf8");
    return content.length > MAX_BYTES_PER_FILE ? `${content.slice(0, MAX_BYTES_PER_FILE)}\n[truncated]` : content;
  } catch {
    return "";
  }
}

async function listFiles(cwd: string, maxEntries = MAX_FILES): Promise<string[]> {
  return walkDir(cwd, {
    skipDirs: new Set([".git", "node_modules"]),
    maxDepth: 3,
    maxFiles: maxEntries,
    relativePaths: true,
    sortEntries: true
  });
}

function extractMarkdownLinks(content: string): string[] {
  const links = new Set<string>();
  const inline = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of inline) {
    const href = match[1]?.trim();
    if (href && !href.startsWith("#")) links.add(href);
  }
  const autolinks = content.matchAll(/<((?:https?:\/\/|mailto:)[^>]+)>/g);
  for (const match of autolinks) {
    const href = match[1]?.trim();
    if (href) links.add(href);
  }
  return [...links];
}

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/)?.[2]?.trim())
    .filter((heading): heading is string => Boolean(heading))
    .slice(0, MAX_HEADINGS);
}

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

async function buildExcerpts(cwd: string, files: string[]): Promise<string> {
  const blocks: string[] = [];
  for (const file of files.slice(0, MAX_EXCERPT_FILES)) {
    const content = await safeRead(path.join(cwd, file));
    if (!content) continue;
    blocks.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
  }
  return blocks.join("\n\n");
}

export async function gatherWorkspaceArtifacts(workspace: PreparedWorkspace): Promise<WorkspaceArtifacts> {
  const files = await listFiles(workspace.cwd);
  let changedFiles = files;
  let diffStat = "";

  if (workspace.isRepo) {
    if (workspace.repoPath) {
      const baseBranch = await defaultBaseBranch(workspace.repoPath);
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("git", ["diff", "--stat", `${baseBranch}...HEAD`], {
          cwd: workspace.cwd,
          maxBuffer: 1024 * 1024
        });
        diffStat = stdout.trim();
      } catch {
        diffStat = "";
      }
    }
    if (workspace.repoPath) {
      const baseBranch = await defaultBaseBranch(workspace.repoPath);
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${baseBranch}...HEAD`], {
          cwd: workspace.cwd
        });
        const gitChanged = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        if (gitChanged.length) changedFiles = gitChanged;
      } catch {
        /* keep listed files */
      }
    }
  }

  const markdownFiles = files.filter((file) => /\.(md|mdx|html?)$/i.test(file));
  const textBlobs = await Promise.all(markdownFiles.map((file) => safeRead(path.join(workspace.cwd, file))));
  const combined = textBlobs.join("\n");
  const markdownLinks = extractMarkdownLinks(combined).slice(0, MAX_LINKS);
  const headings = extractHeadings(combined);
  const wordCount = countWords(combined);
  const fileExcerpts = await buildExcerpts(workspace.cwd, changedFiles.length ? changedFiles : markdownFiles);

  return {
    files,
    markdownLinks,
    headings,
    wordCount,
    diffStat,
    changedFiles,
    fileExcerpts
  };
}

export function formatWorkspaceArtifactsSection(artifacts: WorkspaceArtifacts): string {
  const fileList = artifacts.changedFiles.length
    ? artifacts.changedFiles.map((file) => `- ${file}`).join("\n")
    : artifacts.files.map((file) => `- ${file}`).join("\n");
  const linkList = artifacts.markdownLinks.length
    ? artifacts.markdownLinks.map((link) => `- ${link}`).join("\n")
    : "- (none extracted)";
  const headingList = artifacts.headings.length
    ? artifacts.headings.map((heading) => `- ${heading}`).join("\n")
    : "- (none extracted)";

  return [
    "## Workspace artifacts (gathered programmatically)",
    "",
    "The harness collected these from your cwd. Use them as ground truth; read more files only when needed.",
    "",
    artifacts.diffStat ? `### Diff stat\n\`\`\`\n${artifacts.diffStat}\n\`\`\`` : "",
    "",
    "### Changed / present files",
    fileList || "- (none)",
    "",
    "### Markdown links",
    linkList,
    "",
    "### Headings",
    headingList,
    "",
    `### Word count (markdown/html files): ${artifacts.wordCount}`,
    "",
    artifacts.fileExcerpts ? `### File excerpts\n${artifacts.fileExcerpts}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}