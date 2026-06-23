import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { walkDirDetailed } from "../infra/walk-dir.ts";

export interface TargetCompletion {
  label: string;
  path: string;
  kind: "file" | "directory";
  insertText: string;
}

export const MAX_COMPLETIONS = 20;
const MAX_FUZZY_VISITED = 4000;
const MAX_RECURSIVE_DEPTH = 12;
const MAX_RECURSIVE_VISITED = 8000;
const SKIPPED_DIRS = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".next",
  ".nx",
  ".turbo",
  "Library",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

export function pathMatchesSearch(
  fullPath: string,
  raw: string,
  partial: string,
  home: string,
  pathNavigation = false
): boolean {
  const relative = path.relative(home, fullPath).toLowerCase();
  const lowerPath = fullPath.toLowerCase();
  const base = path.basename(fullPath).toLowerCase();

  if (pathNavigation) {
    const lowerRaw = raw.toLowerCase().replace(/\/$/, "");
    if (lowerRaw.includes("/")) {
      return relative.includes(lowerRaw) || lowerPath.includes(lowerRaw);
    }
    if (partial) {
      return base.startsWith(partial);
    }
    return relative === lowerRaw || relative.startsWith(`${lowerRaw}/`);
  }

  const query = (partial || raw).toLowerCase().replace(/\/$/, "");
  if (!query) {
    return true;
  }
  return relative.includes(query) || lowerPath.includes(query);
}

export function completionLabel(fullPath: string, home: string, kind: "file" | "directory"): string {
  const relative = path.relative(home, fullPath);
  const display = relative && !relative.startsWith("..") ? relative : fullPath;
  const base = path.basename(fullPath);
  if (display === base || display.endsWith(`${path.sep}${base}`)) {
    return `${base}${kind === "directory" ? "/" : ""}`;
  }
  return `${display}${kind === "directory" ? "/" : ""}`;
}

export async function toTargetCompletion(
  fullPath: string,
  home: string
): Promise<TargetCompletion | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(fullPath);
  } catch {
    return undefined;
  }

  const kind = info.isDirectory() ? "directory" : "file";
  return {
    label: completionLabel(fullPath, home, kind),
    path: fullPath,
    kind,
    insertText: `@${fullPath}`
  };
}

function scorePathMatch(fullPath: string, query: string, home: string, isDirectory: boolean): number {
  if (!query) {
    return isDirectory ? 100 : 50;
  }

  const base = path.basename(fullPath).toLowerCase();
  const relative = path.relative(home, fullPath).toLowerCase();
  const lowerPath = fullPath.toLowerCase();

  if (base === query) return 1000;
  if (base.startsWith(query)) return 800;
  if (base.includes(query)) return 600;
  if (relative.includes(query) || lowerPath.includes(query)) return 400;
  return 0;
}

function entryToCompletion(fullPath: string, isDirectory: boolean, home: string): TargetCompletion {
  const kind = isDirectory ? "directory" : "file";
  return {
    label: completionLabel(fullPath, home, kind),
    path: fullPath,
    kind,
    insertText: `@${fullPath}`
  };
}

function recordRankedMatch(
  ranked: Map<string, TargetCompletion & { score: number }>,
  fullPath: string,
  isDirectory: boolean,
  query: string,
  home: string
): void {
  const score = scorePathMatch(fullPath, query, home, isDirectory);
  if (score <= 0) {
    return;
  }

  const suggestion = entryToCompletion(fullPath, isDirectory, home);
  const existing = ranked.get(suggestion.path);
  if (!existing || score > existing.score) {
    ranked.set(suggestion.path, { ...suggestion, score });
  }
}

function sortRankedMatches(ranked: Map<string, TargetCompletion & { score: number }>): TargetCompletion[] {
  return [...ranked.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.path.localeCompare(b.path)
    )
    .slice(0, MAX_COMPLETIONS)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

async function searchTargetSubtree(
  searchRoot: string,
  query: string,
  home: string,
  ranked: Map<string, TargetCompletion & { score: number }>,
  visitBudget: number
): Promise<void> {
  let visited = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_RECURSIVE_DEPTH || visited >= visitBudget || ranked.size >= MAX_COMPLETIONS) {
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= visitBudget || ranked.size >= MAX_COMPLETIONS) {
        return;
      }

      const name = entry.name;
      if (name.startsWith(".")) continue;

      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(name)) continue;
        visited += 1;
        recordRankedMatch(ranked, fullPath, true, query, home);
        await visit(fullPath, depth + 1);
        continue;
      }

      recordRankedMatch(ranked, fullPath, false, query, home);
    }
  }

  await visit(searchRoot, 0);
}

async function recursiveTargetSearch(
  searchRoot: string,
  query: string,
  home: string
): Promise<TargetCompletion[]> {
  const normalizedQuery = query.toLowerCase().replace(/\/$/, "");
  const ranked = new Map<string, TargetCompletion & { score: number }>();

  let topEntries: Dirent<string>[];
  try {
    topEntries = await readdir(searchRoot, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const subroots = topEntries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)
  );

  for (const entry of topEntries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(searchRoot, entry.name);
    recordRankedMatch(ranked, fullPath, entry.isDirectory(), normalizedQuery, home);
  }

  if (subroots.length === 0) {
    await searchTargetSubtree(searchRoot, normalizedQuery, home, ranked, MAX_RECURSIVE_VISITED);
    return sortRankedMatches(ranked);
  }

  const visitBudget = Math.max(500, Math.floor(MAX_RECURSIVE_VISITED / subroots.length));
  await Promise.all(
    subroots.map((entry) =>
      searchTargetSubtree(path.join(searchRoot, entry.name), normalizedQuery, home, ranked, visitBudget)
    )
  );

  return sortRankedMatches(ranked);
}

export async function fuzzyFindTargets(
  searchRoot: string,
  raw: string,
  partial: string,
  home: string,
  pathNavigation: boolean
): Promise<TargetCompletion[]> {
  const query = (partial || raw).toLowerCase().replace(/\/$/, "");
  if (!pathNavigation) {
    return recursiveTargetSearch(searchRoot, query, home);
  }

  if (raw.includes("/")) {
    return recursiveTargetSearch(searchRoot, raw, home);
  }

  const matches: TargetCompletion[] = [];
  const maxDepth = 2;

  await walkDirDetailed(searchRoot, {
    skipDotEntries: true,
    skipDirs: SKIPPED_DIRS,
    maxDepth,
    maxVisited: MAX_FUZZY_VISITED,
    onEntry: (entry, context) => {
      if (pathMatchesSearch(entry.fullPath, raw, partial, home, true)) {
        matches.push(entryToCompletion(entry.fullPath, entry.isDirectory, home));
        if (matches.length >= MAX_COMPLETIONS) {
          context.stop();
          return false;
        }
      }

      if (entry.isDirectory) {
        return context.depth < maxDepth;
      }
    }
  });

  return matches;
}
