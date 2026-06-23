import os from "node:os";
import path from "node:path";

import { ACTIVITY_THRESHOLDS, type ActivityThresholds } from "./tasks/activity.ts";
import { readJsonFile, writeJsonFile } from "./infra/fs.ts";
import { ensureHarnessRepository } from "./bootstrap/repository.ts";
import type { ToolId } from "./types.ts";

export type HarnessTheme = "dark" | "light";

export interface HarnessSettings {
  /** Agent used for all automated harness turns unless a per-stage override is set. */
  defaultAgent: ToolId;
  /** UI stall / long-run warning thresholds. */
  activityThresholds: ActivityThresholds;
  /** UI color theme. */
  theme: HarnessTheme;
  /** Root directory scanned for @ target completion (repos, projects). */
  projectsRoot: string;
}

/** Portable default before settings.json exists; override with HARNESS_PROJECTS_ROOT. */
export function defaultProjectsRoot(): string {
  const fromEnv = process.env["HARNESS_PROJECTS_ROOT"]?.trim();
  if (fromEnv) return expandSettingsPath(fromEnv);
  return path.join(os.homedir(), "repos");
}

export function expandSettingsPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return defaultProjectsRoot();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  defaultAgent: "grok",
  activityThresholds: { ...ACTIVITY_THRESHOLDS },
  theme: "dark",
  projectsRoot: defaultProjectsRoot()
};

const VALID_THEMES = new Set<HarnessTheme>(["dark", "light"]);

function settingsPath(root: string): string {
  return path.join(root, "data", "state", "settings.json");
}

function normalizeActivityThresholds(raw: Partial<ActivityThresholds> | undefined): ActivityThresholds {
  const staleMs = Number(raw?.staleMs);
  const longRunMs = Number(raw?.longRunMs);
  return {
    staleMs:
      Number.isFinite(staleMs) && staleMs >= 30_000
        ? Math.floor(staleMs)
        : DEFAULT_HARNESS_SETTINGS.activityThresholds.staleMs,
    longRunMs:
      Number.isFinite(longRunMs) && longRunMs >= 60_000
        ? Math.floor(longRunMs)
        : DEFAULT_HARNESS_SETTINGS.activityThresholds.longRunMs
  };
}

function normalizeSettings(raw: Partial<HarnessSettings> | null | undefined): HarnessSettings {
  const agent =
    typeof raw?.defaultAgent === "string" && raw.defaultAgent.trim()
      ? raw.defaultAgent.trim()
      : DEFAULT_HARNESS_SETTINGS.defaultAgent;

  const theme = typeof raw?.theme === "string" ? (raw.theme.trim() as HarnessTheme) : DEFAULT_HARNESS_SETTINGS.theme;
  if (!VALID_THEMES.has(theme)) {
    throw new Error(`Invalid theme "${String(raw?.theme)}".`);
  }

  const projectsRoot =
    typeof raw?.projectsRoot === "string" && raw.projectsRoot.trim()
      ? expandSettingsPath(raw.projectsRoot)
      : defaultProjectsRoot();

  return {
    defaultAgent: agent,
    activityThresholds: normalizeActivityThresholds(raw?.activityThresholds),
    theme,
    projectsRoot
  };
}

export async function loadHarnessSettings(root: string): Promise<HarnessSettings> {
  await ensureHarnessRepository(root);
  const stored = await readJsonFile<Partial<HarnessSettings> | null>(settingsPath(root), null);
  if (!stored) return { ...DEFAULT_HARNESS_SETTINGS };
  return normalizeSettings(stored);
}

async function saveHarnessSettings(root: string, settings: HarnessSettings): Promise<HarnessSettings> {
  const normalized = normalizeSettings(settings);
  await writeJsonFile(settingsPath(root), normalized);
  return normalized;
}

export async function updateHarnessSettings(
  root: string,
  patch: Partial<HarnessSettings>
): Promise<HarnessSettings> {
  const current = await loadHarnessSettings(root);
  return saveHarnessSettings(root, {
    ...current,
    ...patch,
    activityThresholds: patch.activityThresholds
      ? normalizeActivityThresholds({ ...current.activityThresholds, ...patch.activityThresholds })
      : current.activityThresholds
  });
}