import crypto from "node:crypto";
import path from "node:path";

import { asRecord } from "../infra/record.ts";
import { ensureDir, readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { emitStateChange } from "../infra/state-bus.ts";
import { loadHarnessSettings } from "../settings.ts";
import { createRunnerForTool } from "../../runners/index.ts";
import type { AgentRunner } from "../../runners/types.ts";
import type { HarnessTarget, HarnessTask, ToolId } from "../types.ts";
import { projectDir, type ProjectRecord } from "./registry.ts";

/** A first-use starter: a button label plus a complete, fillable prompt. */
export interface QuickStart {
  label: string;
  prompt: string;
}

export type QuickstartsStatus = "default" | "generating" | "ready" | "failed";

export interface QuickstartsFile {
  status: QuickstartsStatus;
  quickstarts: QuickStart[];
  /** ISO timestamp the tailored set was produced. */
  generatedAt?: string;
  /** Repo the tailored set was generated against. */
  repoPath?: string;
  /** Why generation failed (status === "failed"). */
  error?: string;
}

export const QUICKSTART_MIN = 3;
export const QUICKSTART_MAX = 6;

/**
 * Generic, project-agnostic starters shown before (or instead of) a tailored
 * set. Each prompt is a complete, well-formed request with [bracketed] slots
 * the operator fills in — not a sentence fragment.
 */
export const DEFAULT_QUICKSTARTS: QuickStart[] = [
  {
    label: "Investigate a bug",
    prompt:
      "Investigate a bug in [area/file]. Symptom: [what happens]. Expected: [what should happen]. " +
      "Reproduce by [steps]. Find the root cause before proposing a fix, and add a regression test."
  },
  {
    label: "Add a feature",
    prompt:
      "Add a feature: [what it should do] for [who/where]. Acceptance: [observable behavior]. " +
      "Follow the existing patterns in [area], and cover it with tests."
  },
  {
    label: "Improve test coverage",
    prompt:
      "Add test coverage for [module/function]. Focus on [edge cases / untested branches]. " +
      "Match the existing test style and keep the suite green."
  },
  {
    label: "Refactor a module",
    prompt:
      "Refactor [module/file] to [goal: simplify / remove duplication / extract helper]. " +
      "Preserve behavior exactly and rely on the existing tests to prove it."
  }
];

const MAX_GENERATION_ATTEMPTS = 3;
const DEFAULT_QUICKSTARTS_TIMEOUT_MS = 3 * 60 * 1000;

/** In-flight generation guard, keyed `${root}:${projectId}` (mirrors intake). */
const activeGenerations = new Set<string>();

function now(): string {
  return new Date().toISOString();
}

function quickstartsPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "quickstarts.json");
}

/** The stored tailored set, or the defaults when nothing has been generated. */
export async function readProjectQuickstarts(root: string, projectId: string): Promise<QuickstartsFile> {
  const stored = await readJsonFile<QuickstartsFile | null>(quickstartsPath(root, projectId), null);
  if (stored && Array.isArray(stored.quickstarts) && stored.quickstarts.length >= QUICKSTART_MIN) {
    return stored;
  }
  return { status: "default", quickstarts: DEFAULT_QUICKSTARTS };
}

async function writeQuickstarts(root: string, projectId: string, file: QuickstartsFile): Promise<void> {
  await ensureDir(projectDir(root, projectId));
  await writeJsonFile(quickstartsPath(root, projectId), file);
  emitStateChange(["chrome"]);
}

export type QuickstartsValidation =
  | { ok: true; quickstarts: QuickStart[] }
  | { ok: false; errors: string[] };

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractJsonText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("[") || text.startsWith("{")) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return fenced ?? null;
}

function itemsFromJson(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const doc = asRecord(value, "quickstarts", { orNull: true });
  if (doc && Array.isArray(doc["quickstarts"])) return doc["quickstarts"] as unknown[];
  return null;
}

/**
 * Parse and validate agent output into quick starts. Clamps more than
 * {@link QUICKSTART_MAX} items down to the cap; rejects fewer than
 * {@link QUICKSTART_MIN} valid items. Accepts a bare array, a
 * `{ quickstarts: [...] }` envelope, or a ```json fence.
 */
export function parseAndValidateQuickstarts(raw: string): QuickstartsValidation {
  const jsonText = extractJsonText(raw);
  if (!jsonText) {
    return { ok: false, errors: ["Response must be a JSON array of { label, prompt } objects."] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, errors: [`JSON parse error: ${(err as Error).message}`] };
  }

  const items = itemsFromJson(parsed);
  if (!items) {
    return { ok: false, errors: ["Expected a JSON array of { label, prompt } objects."] };
  }

  const valid: QuickStart[] = [];
  for (const entry of items) {
    const doc = asRecord(entry, "quickstart", { orNull: true });
    if (!doc) continue;
    const label = trimmed(doc["label"]);
    const prompt = trimmed(doc["prompt"]);
    if (label && prompt) valid.push({ label, prompt });
  }

  if (valid.length < QUICKSTART_MIN) {
    return {
      ok: false,
      errors: [`Need at least ${QUICKSTART_MIN} quick starts with a non-empty label and prompt; got ${valid.length}.`]
    };
  }

  return { ok: true, quickstarts: valid.slice(0, QUICKSTART_MAX) };
}

export function buildQuickstartsPrompt(project: ProjectRecord): string {
  return `You are tailoring "quick start" suggestions for a software project so an operator can open a well-scoped ticket in one click.

## Project

- name: ${project.name}
- repoPath: ${project.repoPath}

## Your task

Inspect the repository read-only — README, package/build manifests, top-level directory layout, and recent commit history — to understand what this project is and what work it plausibly needs next. Do not edit files or run commands that change state.

Then propose between ${QUICKSTART_MIN} and ${QUICKSTART_MAX} quick starts. Each is:
- "label": a short button caption (2-4 words), specific to this project.
- "prompt": a complete, ready-to-send request with a few [bracketed] slots the operator fills in. Reference real areas, files, or components you found. No filler.

## Response format (strict)

Return ONE JSON array and nothing else — no prose, no markdown fences:

[
  { "label": "...", "prompt": "... [slot] ..." }
]

Each prompt must contain at least one [bracketed] slot. Return ${QUICKSTART_MIN}-${QUICKSTART_MAX} items.`;
}

function buildCorrectionPrompt(errors: string[]): string {
  return `Your previous quick-starts response was rejected:
${errors.map((error) => `- ${error}`).join("\n")}

Respond again with ONE JSON array of ${QUICKSTART_MIN}-${QUICKSTART_MAX} { "label", "prompt" } objects, no markdown fences, no text outside the JSON. Each prompt must include at least one [bracketed] slot.`;
}

export interface GenerateQuickstartsOptions {
  runner?: AgentRunner;
  agent?: ToolId;
  timeoutMs?: number;
}

function projectRepoTargets(project: ProjectRecord): HarnessTarget[] {
  return [{ raw: `@${project.repoPath}`, path: project.repoPath, kind: "directory" }];
}

async function runTurnWithTimeout(
  runner: AgentRunner,
  request: Parameters<AgentRunner["runTurn"]>[0],
  timeoutMs: number
): ReturnType<AgentRunner["runTurn"]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runner.runTurn(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          runner.abort();
          reject(new Error(`Quick-starts generation timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate tailored quick starts for a project via a read-only (plan-mode)
 * agent turn. Writes "generating" up front, then "ready" with the parsed set
 * or "failed" (falling back to defaults) so the UI always has something to
 * render. Resolves once the file is written; safe to await or fire-and-forget.
 */
export async function generateProjectQuickstarts(
  root: string,
  project: ProjectRecord,
  options?: GenerateQuickstartsOptions
): Promise<QuickstartsFile> {
  const existing = await readProjectQuickstarts(root, project.id);
  await writeQuickstarts(root, project.id, { ...existing, status: "generating" });

  try {
    const agent = options?.agent ?? (await loadHarnessSettings(root)).defaultAgent;
    const runner = options?.runner ?? (await createRunnerForTool(root, agent, "author"));
    const timestamp = now();
    const stubTask: HarnessTask = {
      id: crypto.randomUUID(),
      title: `Quick starts for ${project.name}`,
      description: "Generate project-specific quick starts",
      agent,
      source: "autonomy",
      links: [],
      targets: projectRepoTargets(project),
      messages: [],
      projectId: project.id,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    let lastErrors: string[] = ["No response."];
    let sessionId: string | undefined;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      const prompt = attempt === 1 ? buildQuickstartsPrompt(project) : buildCorrectionPrompt(lastErrors);
      const result = await runTurnWithTimeout(
        runner,
        {
          mode: "plan",
          task: stubTask,
          prompt,
          cwd: project.repoPath,
          turnNumber: attempt,
          label: "quickstarts",
          ...(sessionId !== undefined ? { sessionId } : {})
        },
        options?.timeoutMs ?? DEFAULT_QUICKSTARTS_TIMEOUT_MS
      );
      sessionId = result.sessionId ?? sessionId;

      const validation = parseAndValidateQuickstarts(result.reply);
      if (validation.ok) {
        const file: QuickstartsFile = {
          status: "ready",
          quickstarts: validation.quickstarts,
          generatedAt: now(),
          repoPath: project.repoPath
        };
        await writeQuickstarts(root, project.id, file);
        return file;
      }
      lastErrors = validation.errors;
    }

    throw new Error(lastErrors.join("; "));
  } catch (err) {
    const file: QuickstartsFile = {
      status: "failed",
      quickstarts: DEFAULT_QUICKSTARTS,
      error: (err as Error).message
    };
    await writeQuickstarts(root, project.id, file);
    return file;
  }
}

/**
 * Fire-and-forget tailored generation with an in-flight guard so a re-trigger
 * (or a fast double onboard) doesn't run two turns for the same project.
 */
export function startProjectQuickstarts(
  root: string,
  project: ProjectRecord,
  options?: GenerateQuickstartsOptions
): void {
  const key = `${root}:${project.id}`;
  if (activeGenerations.has(key)) return;
  activeGenerations.add(key);
  void generateProjectQuickstarts(root, project, options)
    .catch(() => {})
    .finally(() => activeGenerations.delete(key));
}
