import crypto from "node:crypto";

import { loadHarnessSettings } from "../settings.ts";
import { createRunnerForTool } from "../../runners/index.ts";
import type { AgentRunner } from "../../runners/types.ts";
import type { HarnessTarget, HarnessTask, ToolId } from "../types.ts";
import { gatherProjectIntel, type ProjectIntel } from "./intel.ts";
import type { ProjectRecord } from "./registry.ts";
import {
  parseAndValidateQualityGate,
  pendingQualityGate,
  synthesizeGateFromIntel,
  writeQualityGate,
  type QualityGateFile
} from "./quality-gate.ts";

const MAX_GENERATION_ATTEMPTS = 3;
const DEFAULT_QUALITY_GATE_TIMEOUT_MS = 3 * 60 * 1000;

/** In-flight generation guard, keyed `${root}:${projectId}` (mirrors quickstarts). */
const activeGenerations = new Set<string>();

function now(): string {
  return new Date().toISOString();
}

function intelPromptSection(intel: ProjectIntel): string {
  const lines: string[] = [];
  if (intel.summary.length) {
    lines.push("## Gathered intel (deterministic, evidence-only)", "", intel.summary.map((l) => `- ${l}`).join("\n"), "");
  }
  if (intel.commands.length) {
    lines.push(
      "## Evidence-backed commands found",
      "",
      intel.commands.map((c) => `- [${c.category}] \`${c.command}\` — source: ${c.source}`).join("\n"),
      ""
    );
  }
  if (intel.docs.length) {
    lines.push(
      "## Commands mentioned in docs (verify before trusting)",
      "",
      intel.docs.map((d) => `- ${d.path}: ${d.commands.map((c) => `\`${c}\``).join(", ")}`).join("\n"),
      ""
    );
  }
  if (intel.ci.length) {
    lines.push(
      "## Commands run by CI",
      "",
      intel.ci.map((c) => `- \`${c.command}\` — source: ${c.source}`).join("\n"),
      ""
    );
  }
  return lines.join("\n");
}

export function buildQualityGatePrompt(project: ProjectRecord, intel: ProjectIntel): string {
  const hasEvidence = intel.commands.length > 0 || intel.docs.length > 0 || intel.ci.length > 0;
  return `You are generating a project-specific quality-gate config for a software project so the harness runs the correct build/test/lint commands for THIS repo, not a generic gate.

## Project

- name: ${project.name}
- repoPath: ${project.repoPath}

## Your task

Inspect the repository read-only to confirm and curate the gathered intel into a quality-gate config. You may open README/docs, manifests, the Makefile, and CI workflows to verify commands. Do not edit files or run state-changing commands.

${intelPromptSection(intel)}

## Rules (strict)

- The config schema is language/tool-agnostic. Emit categories from: lint, test, typecheck, build, format, security, other. Never hard-code a single toolchain.
- The gate verifies, it does not mutate. Emit ONLY commands that check the repo (lint, test, typecheck, build, security, format). NEVER emit install/fetch, publish, deploy, serve, release, or ship commands; they mutate state or hit the network and have no place as a check. Categorize honestly: a command that does not verify belongs in no category, not smuggled under "build" or "test".
- Prefer EXPLICIT repo-provided commands (docs, Makefile targets, package scripts, CI steps) over inferred invocations.
- Every check MUST cite concrete evidence (the file/section/target it came from). A command with no repo evidence is a guess — do not emit it.
- Each check command MUST be a single direct invocation: one program and its arguments, nothing more. The gate runs commands without a shell, so do NOT chain with && or ||, pipe, redirect, background with &, use command substitution ($(...) or backticks), prefix a leading NAME=value assignment, or prefix with cd. A chain like \`npm run lint && npm run test\` would silently run only the first stage; emit two separate checks instead, and set "workingDirectory" to run a command from a subdirectory.
- Do NOT invent a generic gate. If you cannot find evidence for a needed category, set "status": "incomplete" and list the gaps in "needsResolution".
- ${
    hasEvidence
      ? "Evidence was found: return status \"ready\" with the curated checks, or \"incomplete\" only if the evidence is genuinely insufficient."
      : "No deterministic evidence was found: read the repo yourself. If you still find none, return status \"incomplete\" with needsResolution."
  }

## Response format (strict)

Return ONE JSON object and nothing else — no prose, no markdown fences:

{
  "status": "ready",
  "checks": [
    { "name": "lint", "category": "lint", "command": "<exact command>", "required": true, "evidence": ["<source>"], "workingDirectory": "<optional>" }
  ],
  "rationale": "<one or two sentences>"
}

For an insufficient repo, return instead:

{ "status": "incomplete", "checks": [], "needsResolution": ["<gap>"], "rationale": "<...>" }`;
}

function buildCorrectionPrompt(errors: string[]): string {
  return `Your previous quality-gate response was rejected:
${errors.map((error) => `- ${error}`).join("\n")}

Respond again with ONE JSON object. For a ready config, include at least one check with a non-empty command AND at least one evidence string. For an incomplete config, include at least one needsResolution entry. No markdown fences, no text outside the JSON.`;
}

export interface GenerateQualityGateOptions {
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
          reject(new Error(`Quality-gate generation timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stamp a config (generatedAt/repoPath) and persist it, returning the exact object
 * that was written. Callers must return this value rather than their pre-stamp input,
 * so a wait-mode regenerate response is identical to a subsequent GET.
 */
async function stampAndStore(
  root: string,
  projectId: string,
  file: QualityGateFile,
  repoPath: string
): Promise<QualityGateFile> {
  const stamped: QualityGateFile = { ...file, generatedAt: now(), repoPath };
  await writeQualityGate(root, projectId, stamped);
  return stamped;
}

/**
 * Generate a project-specific quality-gate config. Gathers intel deterministically,
 * then asks the agent to curate it into a config. If the agent never returns valid
 * output, falls back to a deterministic, evidence-only synthesis — never a generic
 * gate. Resolves once the file is written; safe to await or fire-and-forget.
 */
export async function generateProjectQualityGate(
  root: string,
  project: ProjectRecord,
  options?: GenerateQualityGateOptions
): Promise<QualityGateFile> {
  // Persist `generating` up front, before intel gathering or any agent turn. This
  // covers direct (awaited) callers: while they await the long intel/agent work, a
  // concurrent project-scoped check plan read sees `generating` rather than `pending`
  // (the generic-baseline interim). The fire-and-forget onboarding race, where the
  // caller proceeds before any write lands, is closed by startProjectQualityGate's
  // own eager write; this one overwrites it promptly with the same `generating`
  // state (or `failed` below) as intel gathering proceeds.
  await writeQualityGate(root, project.id, { ...pendingQualityGate(), status: "generating" });

  let intel: ProjectIntel;
  try {
    intel = await gatherProjectIntel(project.repoPath);
  } catch (err) {
    const failed: QualityGateFile = {
      status: "failed",
      checks: [],
      error: `Intel gathering failed: ${(err as Error).message}`
    };
    await writeQualityGate(root, project.id, failed);
    return failed;
  }

  await writeQualityGate(root, project.id, { ...pendingQualityGate(), status: "generating", intel });

  let agentError: string | null = null;
  try {
    const agent = options?.agent ?? (await loadHarnessSettings(root)).defaultAgent;
    const runner = options?.runner ?? (await createRunnerForTool(root, agent, "author"));
    const timestamp = now();
    const stubTask: HarnessTask = {
      id: crypto.randomUUID(),
      title: `Quality gate for ${project.name}`,
      description: "Generate a project-specific quality-gate config",
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
      const prompt = attempt === 1 ? buildQualityGatePrompt(project, intel) : buildCorrectionPrompt(lastErrors);
      const result = await runTurnWithTimeout(
        runner,
        {
          mode: "plan",
          task: stubTask,
          prompt,
          cwd: project.repoPath,
          turnNumber: attempt,
          ...(sessionId !== undefined ? { sessionId } : {})
        },
        options?.timeoutMs ?? DEFAULT_QUALITY_GATE_TIMEOUT_MS
      );
      sessionId = result.sessionId ?? sessionId;

      const validation = parseAndValidateQualityGate(result.reply);
      if (validation.ok) {
        return stampAndStore(root, project.id, { ...validation.file, intel }, project.repoPath);
      }
      lastErrors = validation.errors;
    }
  } catch (err) {
    // Agent/runner failure: fall through to deterministic synthesis below, but
    // record the cause so the operator can see why the agent path was skipped.
    agentError = (err as Error).message;
  }

  const fallback = synthesizeGateFromIntel(intel);
  const note =
    agentError !== null
      ? `${fallback.rationale ?? ""} Agent generation failed (${agentError}); fell back to deterministic synthesis.`
      : `${fallback.rationale ?? ""} Agent did not return valid output; fell back to deterministic synthesis.`;
  return stampAndStore(root, project.id, { ...fallback, rationale: note.trim(), intel }, project.repoPath);
}

/**
 * Fire-and-forget generation with an in-flight guard so a re-trigger (or a fast
 * double onboard) doesn't run two turns for the same project.
 *
 * Durably writes `generating` before resolving, so the caller can proceed to a
 * project-scoped check plan read the instant this returns without ever observing
 * `pending` (the generic-baseline interim). Only that first write is awaited; the
 * intel gathering and agent turn run detached and overwrite `generating` with the
 * terminal config when they land.
 */
export async function startProjectQualityGate(
  root: string,
  project: ProjectRecord,
  options?: GenerateQualityGateOptions
): Promise<void> {
  const key = `${root}:${project.id}`;
  if (activeGenerations.has(key)) return;
  activeGenerations.add(key);
  await writeQualityGate(root, project.id, { ...pendingQualityGate(), status: "generating" });
  void generateProjectQualityGate(root, project, options)
    .catch(() => {})
    .finally(() => activeGenerations.delete(key));
}
