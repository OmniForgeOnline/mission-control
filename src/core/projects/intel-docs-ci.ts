import path from "node:path";

import { listFileNames, pathExists, readTextFile } from "../infra/fs.ts";
import { walkDir } from "../infra/walk-dir.ts";
import type { DetectedCommand, DocExcerpt, GateCategory } from "./intel.ts";

const DOC_KEYWORDS =
  /\b(test|tests|pytest|lint|lints|ruff|eslint|biome|typecheck|type-check|mypy|tsc|build|compile|check|ci|format|prettier|black|make|npm|yarn|pnpm|cargo|gradle|mvn|go test|rake)\b/i;
const DOC_GLOB = /^(readme|contributing|develop|building|hacking)\b.*\.(md|markdown|rst|txt)$/i;
/** Doc-home directories: their presence signals documentation, so any doc file
 *  inside them is a candidate (e.g. `docs/build.md`, `.github/CONTRIBUTING.md`). */
const DOC_DIRS = ["docs", "doc", ".docs", ".github"];
/** File extensions treated as documentation within doc-home directories. */
const DOC_EXTENSIONS = /\.(md|markdown|rst|txt)$/i;
/** Never descended into while scanning for docs (deps / build output / vcs). */
const DOC_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".git",
  ".next",
  ".cache",
  "__pycache__"
]);

function cleanDocCommand(raw: string): string {
  return raw
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/^\$?\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/`/g, "")
    .trim();
}

/** Extract build/test/lint shell commands from a doc's text, in encounter order. */
function extractDocCommands(text: string): string[] {
  const commands = new Set<string>();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Fenced code block: each non-blank line is a candidate shell command.
      const candidate = cleanDocCommand(line);
      if (candidate && DOC_KEYWORDS.test(candidate)) commands.add(candidate);
      continue;
    }
    // Prose: harvest inline `code spans` that mention a build/test/lint keyword.
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const candidate = cleanDocCommand(match[1]!);
      if (candidate && DOC_KEYWORDS.test(candidate)) commands.add(candidate);
    }
  }
  return [...commands];
}

/**
 * Bounded set of doc candidate paths: root-level docs by filename (README /
 * CONTRIBUTING / develop / building / hacking variants) plus any doc file inside
 * doc-home directories (`docs/`, `.github/`, ...), where the directory itself
 * signals documentation. Returns repo-relative paths, deduped and sorted.
 */
async function collectDocCandidatePaths(repoPath: string): Promise<string[]> {
  const found = new Set<string>();
  const rootEntries = await listFileNames(repoPath);
  for (const name of rootEntries) {
    if (DOC_GLOB.test(name)) found.add(name);
  }
  for (const dir of DOC_DIRS) {
    const files = await walkDir(path.join(repoPath, dir), {
      maxDepth: 3,
      maxFiles: 48,
      maxVisited: 200,
      sortEntries: true,
      skipDirs: DOC_SCAN_SKIP_DIRS,
      fileFilter: (entry) => !entry.isDirectory && DOC_EXTENSIONS.test(entry.name)
    });
    for (const fullPath of files) found.add(path.relative(repoPath, fullPath));
  }
  return [...found].sort();
}

/** Collect build/test/lint commands mentioned in human-authored docs. */
export async function collectDocCommands(repoPath: string): Promise<DocExcerpt[]> {
  const candidates = await collectDocCandidatePaths(repoPath);
  const excerpts: DocExcerpt[] = [];

  for (const relPath of candidates) {
    const text = await readTextFile(path.join(repoPath, relPath));
    if (text === null) continue;
    const commands = extractDocCommands(text).slice(0, 8);
    if (commands.length) excerpts.push({ path: relPath, commands });
    if (excerpts.length >= 6) break;
  }
  return excerpts;
}

/** Infer a gate category from a bare command token. Shared by CI/doc collection. */
export function inferCategoryFromToken(command: string): GateCategory {
  const lower = command.toLowerCase();
  if (/\b(ruff|eslint|pylint|biome|flake8)\b/.test(lower)) return "lint";
  if (/\b(pytest|jest|vitest|mocha|test|check)\b/.test(lower)) return "test";
  if (/\b(mypy|tsc|typecheck|type-check)\b/.test(lower)) return "typecheck";
  if (/\b(build|compile|cargo build|go build)\b/.test(lower)) return "build";
  if (/\b(prettier|black|isort|format|fmt)\b/.test(lower)) return "format";
  if (/\b(bandit|safety|audit)\b/.test(lower)) return "security";
  return "other";
}

/** Collect `run:` steps from GitHub Actions workflows as evidence-backed commands. */
export async function collectCiCommands(repoPath: string): Promise<DetectedCommand[]> {
  const workflowsDir = path.join(repoPath, ".github", "workflows");
  if (!(await pathExists(workflowsDir))) return [];

  let files: string[];
  try {
    files = await walkDir(workflowsDir, {
      fileFilter: (entry) => /\.(ya?ml)$/.test(entry.name),
      relativePaths: true
    });
  } catch {
    return [];
  }

  const commands: DetectedCommand[] = [];
  const seen = new Set<string>();
  for (const rel of files.sort()) {
    const text = await readTextFile(path.join(workflowsDir, rel));
    if (text === null) continue;
    for (const line of text.split("\n")) {
      // `run:` steps in GitHub Actions hold the shell commands. Match both
      // bare `run: cmd` and list-item `- run: cmd` forms.
      const runMatch = line.match(/^\s*-\s*run:\s*(.*)$|^\s*run:\s*(.*)$/);
      if (!runMatch) continue;
      const cleaned = cleanDocCommand((runMatch[1] ?? runMatch[2]) ?? "");
      if (!cleaned || !DOC_KEYWORDS.test(cleaned)) continue;
      const category = inferCategoryFromToken(cleaned);
      const key = `${rel}:${cleaned}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push({ command: cleaned, category, source: `CI ${rel} run step` });
    }
  }
  return commands.slice(0, 24);
}
