import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "../infra/fs.ts";
import type { HarnessTarget, HarnessTask } from "../types.ts";
import {
  MAX_COMPLETIONS,
  fuzzyFindTargets,
  pathMatchesSearch,
  toTargetCompletion,
  type TargetCompletion
} from "./target-search.ts";

export type { TargetCompletion } from "./target-search.ts";

export interface TargetOptions {
  homeRoot?: string;
  harnessRoot?: string;
}

const AT_PATH_PATTERN = /@(?:~\/[^\s,;)"']+|\/[^\s,;)"']+|[A-Za-z0-9._-][^\s,;)"']*)/g;
/** Backtick-quoted absolute paths common in intake tickets, e.g. `(/Users/foo/bar)`. */
const BACKTICK_ABSOLUTE_PATH_PATTERN = /`(\/(?:[^`\\]|\\.)*)`/g;

export function homeRootForHarness(root: string): string | undefined {
  const parts = path.resolve(root).split(path.sep);
  const codexIndex = parts.lastIndexOf("codex");
  if (codexIndex > 0 && parts[codexIndex + 1] === "harness") {
    return parts.slice(0, codexIndex).join(path.sep) || path.sep;
  }
  return undefined;
}

export async function resolveWorkspaceFromText(
  text: string,
  options: { fallbackRoot: string; harnessRoot?: string }
): Promise<{ cwd: string; targets: HarnessTarget[] }> {
  const homeRoot = homeRootForHarness(options.harnessRoot ?? options.fallbackRoot);
  const targets = await extractTargets(text, {
    ...(homeRoot !== undefined ? { homeRoot } : {})
  });
  const cwd = await resolveExecutionCwd({ targets }, { fallbackRoot: options.fallbackRoot });
  return { cwd, targets };
}

function allowedHome(options: TargetOptions): string {
  return path.resolve(options.homeRoot || os.homedir());
}

function normalizeTarget(raw: string, options: TargetOptions): string {
  const home = allowedHome(options);
  const trimmed = raw.replace(/[.,;:!?]+$/g, "");
  const withoutPrefix = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const expanded = expandTargetPath(withoutPrefix, home);
  const resolved = path.resolve(expanded);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Target path is outside ${home}: ${raw}`);
  }
  return resolved;
}

function collectTargetCandidates(text: string): string[] {
  const atMatches = text.match(AT_PATH_PATTERN) ?? [];
  const backtickMatches = [...text.matchAll(BACKTICK_ABSOLUTE_PATH_PATTERN)].map((match) => match[1] ?? "");
  return [...new Set([...atMatches, ...backtickMatches].map((entry) => entry.trim()).filter(Boolean))];
}

export async function extractTargets(text: string, options: TargetOptions = {}): Promise<HarnessTarget[]> {
  const targets: HarnessTarget[] = [];
  const seen = new Set<string>();

  for (const raw of collectTargetCandidates(text)) {
    let resolved: string;
    try {
      resolved = normalizeTarget(raw, options);
    } catch (err) {
      if (raw.startsWith("@")) throw err;
      continue;
    }
    if (seen.has(resolved)) continue;

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      continue;
    }

    seen.add(resolved);
    const displayRaw = raw.startsWith("@") ? raw.replace(/[.,;:!?]+$/g, "") : raw;
    targets.push({
      raw: displayRaw,
      path: resolved,
      kind: info.isDirectory() ? "directory" : "file"
    });
  }

  return targets;
}

export async function resolveExecutionCwd(
  task: Pick<HarnessTask, "targets">,
  options: { fallbackRoot: string }
): Promise<string> {
  const first = task.targets[0];
  if (!first) {
    return options.fallbackRoot;
  }
  return first.kind === "directory" ? first.path : path.dirname(first.path);
}

export async function completeTargets(prefix: string, options: TargetOptions = {}): Promise<TargetCompletion[]> {
  if (!prefix.startsWith("@")) {
    return [];
  }
  const home = allowedHome(options);
  const raw = prefix.slice(1);
  const expanded = expandTargetPath(raw, home);
  const resolved = path.resolve(expanded || home);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) {
    return [];
  }

  const parent = !raw || raw.endsWith("/") ? resolved : path.dirname(resolved);
  const partial = !raw || raw.endsWith("/") ? "" : path.basename(resolved).toLowerCase();
  if (parent !== home && !parent.startsWith(`${home}${path.sep}`)) {
    return [];
  }

  const historical = await loadHistoricalTargetPaths(options.harnessRoot, home);
  const ranked = new Map<string, TargetCompletion & { score: number }>();

  const addSuggestion = (suggestion: TargetCompletion, score: number): void => {
    const existing = ranked.get(suggestion.path);
    if (!existing || score > existing.score) {
      ranked.set(suggestion.path, { ...suggestion, score });
    }
  };

  if (partial || raw) {
    const historicalMatches = await historicalTargetSuggestions(historical, raw, partial, home);
    for (const [index, suggestion] of historicalMatches.entries()) {
      addSuggestion(suggestion, 2000 - index);
    }
  }

  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || (partial && !entry.toLowerCase().startsWith(partial))) {
      continue;
    }
    const fullPath = path.join(parent, entry);
    const suggestion = await toTargetCompletion(fullPath, home);
    if (suggestion) {
      addSuggestion(suggestion, 1500);
    }
  }

  const pathNavigation = raw.includes("/");
  const needsFuzzy = !pathNavigation || ranked.size === 0;
  if ((partial || raw) && needsFuzzy && ranked.size < MAX_COMPLETIONS) {
    const fuzzyMatches = await fuzzyFindTargets(home, raw, partial, home, pathNavigation);
    for (const [index, suggestion] of fuzzyMatches.entries()) {
      addSuggestion(suggestion, 1000 - index);
    }
  }

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

function expandTargetPath(raw: string, home: string): string {
  if (!raw) return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, raw);
}

function resolveTargetPath(raw: string, home: string): string | undefined {
  const trimmed = raw.replace(/[.,;:!?]+$/g, "");
  const withoutPrefix = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const expanded = expandTargetPath(withoutPrefix, home);
  const resolved = path.resolve(expanded);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) {
    return undefined;
  }
  return resolved;
}

function recordHistoricalPath(
  paths: Map<string, number>,
  targetPath: string,
  home: string,
  timestamp: number
): void {
  const resolved = path.resolve(targetPath);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) {
    return;
  }
  paths.set(resolved, Math.max(paths.get(resolved) ?? 0, timestamp));
}

async function loadHistoricalTargetPaths(
  harnessRoot: string | undefined,
  home: string
): Promise<Map<string, number>> {
  if (!harnessRoot) {
    return new Map();
  }

  const tasks = await readJsonFile<HarnessTask[]>(path.join(harnessRoot, "data", "state", "tasks.json"), []);
  const paths = new Map<string, number>();

  for (const task of tasks) {
    const timestamp = Date.parse(task.updatedAt);
    if (Number.isNaN(timestamp)) {
      continue;
    }

    for (const target of task.targets ?? []) {
      recordHistoricalPath(paths, target.path, home, timestamp);
    }

    const text = [task.title, task.description, ...(task.messages?.map((message) => message.body) ?? [])].join(
      "\n"
    );
    for (const match of text.match(AT_PATH_PATTERN) ?? []) {
      const resolved = resolveTargetPath(match, home);
      if (resolved) {
        recordHistoricalPath(paths, resolved, home, timestamp);
      }
    }
  }

  return paths;
}

async function historicalTargetSuggestions(
  historical: Map<string, number>,
  raw: string,
  partial: string,
  home: string
): Promise<TargetCompletion[]> {
  const matches = [...historical.entries()]
    .filter(([targetPath]) => pathMatchesSearch(targetPath, raw, partial, home, raw.includes("/")))
    .sort((a, b) => b[1] - a[1]);

  const suggestions: TargetCompletion[] = [];
  for (const [targetPath] of matches) {
    const suggestion = await toTargetCompletion(targetPath, home);
    if (suggestion) {
      suggestions.push(suggestion);
    }
    if (suggestions.length >= MAX_COMPLETIONS) {
      break;
    }
  }

  return suggestions;
}
