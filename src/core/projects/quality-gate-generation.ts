import crypto from "node:crypto";

import { loadHarnessSettings } from "../settings.ts";
import { createRunnerForTool } from "../../runners/index.ts";
import type { AgentRunner } from "../../runners/types.ts";
import type { HarnessTarget, HarnessTask, ToolId } from "../types.ts";
import { gatherProjectIntel, type ProjectIntel } from "./intel.ts";
import { listProjects, type ProjectRecord } from "./registry.ts";
import {
  parseAndValidateQualityGate,
  pendingQualityGate,
  readProjectQualityGate,
  writeQualityGate,
  type QualityGateFile
} from "./quality-gate.ts";

const MAX_GENERATION_ATTEMPTS = 3;
// 5 min: claude retries a transiently-overloaded model API (HTTP 529) up to 10× with
// exponential backoff — ~3 min of waits alone. A budget under that aborts the turn
// mid-retry on every overload spike, so the gate never gets a curated config and
// always falls back. 5 min lets the retries ride out a spike with headroom to spare.
const DEFAULT_QUALITY_GATE_TIMEOUT_MS = 5 * 60 * 1000;

/** In-flight generation guard, keyed `${root}:${projectId}` (mirrors quickstarts). */
const activeGenerations = new Set<string>();

/** True when a generation for this project is currently in flight in this process. */
function isGenerationActive(root: string, projectId: string): boolean {
  return activeGenerations.has(`${root}:${projectId}`);
}

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
  return `You are generating a project-specific quality-gate config. The gate runs the repo's verification commands (lint, test, typecheck, build) on every task turn — it must verify, never mutate.

## Project

- name: ${project.name}
- repoPath: ${project.repoPath}

## Build system — this repo may use any tool

The gathered intel below is a starting point, but it only captures top-level \`package.json\` scripts, declared Python tools, Makefile targets, CI, and docs. Many repos — workspaces (nx, turbo), JVM (maven, gradle), rust, go — define their real verification commands in build-tool **config files**, not \`package.json\` scripts. Find them there.

You MAY read the repo's BUILD/CONFIG files to discover verification commands:

- Node/workspaces: \`package.json\`, \`nx.json\`, \`turbo.json\`, \`**/project.json\`
- JVM: \`pom.xml\`, \`build.gradle\`, \`build.gradle.kts\`, \`settings.gradle\`
- Rust: \`Cargo.toml\` · Go: \`go.mod\` · Ruby: \`Gemfile\` · PHP: \`composer.json\`
- Python: \`pyproject.toml\`, \`setup.py\` · Generic: \`Makefile\`, \`CMakeLists.txt\` · CI: \`.github/workflows/*\`

Read **only** these config/build files. Do NOT read source files (\`*.ts\`, \`*.tsx\`, \`*.js\`, \`*.py\`, \`*.java\`, \`*.rs\`, \`*.go\`, …). Source reading is what blows the time budget; config files are few and small. Be decisive.

## Gathered intel (starting point)

${intelPromptSection(intel)}

## Rules

- Emit ONE check per distinct verification command the repo actually provides, in the build system's own idioms — e.g. maven \`mvn -q verify\`; gradle \`./gradlew test build\`; cargo \`cargo test\`; go \`go test ./...\`; nx \`npx nx run-many -t lint test build\` (only targets that exist); npm \`npm test\` / \`npm run build\`. These illustrate, they are not a closed list — handle whichever tool this repo uses.
- The gate verifies, it does not mutate. NEVER emit install/fetch, publish/deploy/serve/release, run/dev, help, or watch commands. A command that does not verify the repo does not belong in the gate — drop it rather than relabel it.
- Each check command MUST be a single direct invocation (one program + its arguments). The gate runs commands without a shell: no \`&&\`/\`||\`, pipes, redirects, \`&\`, \`$(...)\`/backticks, leading \`NAME=value\`, or leading \`cd\`. A chain would silently mis-run; emit separate checks and use "workingDirectory" to run from a subdirectory.
- Every check MUST cite its evidence (the config file/target/script it came from). No evidence → do not emit.
- If the repo has no verification commands, return status "incomplete" with the gaps in "needsResolution". Do not invent a generic gate.

## Response (strict)

Return ONE JSON object and nothing else — no prose, no markdown fences:

{
  "status": "ready",
  "checks": [
    { "name": "test", "category": "test", "command": "make test", "required": true, "evidence": ["Makefile target \`test\`"] }
  ],
  "rationale": "one short sentence"
}

For insufficient evidence, return instead:

{ "status": "incomplete", "checks": [], "needsResolution": ["<gap>"], "rationale": "<...>" }`;
}

function buildCorrectionPrompt(errors: string[]): string {
  return `Your previous quality-gate response was rejected:
${errors.map((error) => `- ${error}`).join("\n")}

Respond again with ONE JSON object. For a ready config, include at least one check with a non-empty command AND at least one evidence string. For an incomplete config, include at least one needsResolution entry. No markdown fences, no text outside the JSON.`;
}

/**
 * Inspect a captured agent stream log for the dominant reason a turn failed, so the
 * fallback rationale can name the cause (e.g. an overloaded model API) instead of an
 * opaque "timed out". Returns null when no recognized failure signal is present.
 *
 * Reads claude's newline-delimited stream-json `system.api_retry` events, which carry
 * the HTTP status and error the API returned while the harness clock ticked down.
 */
export function summarizeAgentFailure(turnLog: string): string | null {
  const retryLines = turnLog.split("\n").filter((line) => line.includes('"subtype":"api_retry"'));
  if (retryLines.length === 0) return null;
  let status: string | undefined;
  let error: string | undefined;
  for (const line of retryLines) {
    try {
      const event = JSON.parse(line) as { error_status?: number; error?: string };
      if (event.error_status !== undefined) status = String(event.error_status);
      if (typeof event.error === "string") error = event.error;
    } catch {
      /* not a JSON line; ignore */
    }
  }
  const detail =
    error && status ? `${error} (HTTP ${status})` : error ?? (status ? `HTTP ${status}` : "retrying");
  return `model API ${detail} on ${retryLines.length} retr${retryLines.length === 1 ? "y" : "ies"}`;
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
  let lastErrors: string[] = ["No response."];
  let lastTurnLog = "";
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

    let sessionId: string | undefined;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      const prompt = attempt === 1 ? buildQualityGatePrompt(project, intel) : buildCorrectionPrompt(lastErrors);
      // Capture the agent's stream so a timeout (e.g. the model API stuck retrying
      // an overloaded response) can be diagnosed from the failed-gate error instead
      // of presenting as an opaque "timed out". Accumulated via the callback because
      // the await throws on timeout, so a post-await assignment would be skipped.
      lastTurnLog = "";
      const result = await runTurnWithTimeout(
        runner,
        {
          mode: "plan",
          task: stubTask,
          prompt,
          cwd: project.repoPath,
          turnNumber: attempt,
          label: "quality-gate",
          onOutput: (chunk) => {
            lastTurnLog += chunk;
          },
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
    // Agent/runner failure (e.g. a timeout): record the cause so the failed gate
    // the operator sees names the real reason.
    agentError = (err as Error).message;
  }

  // No deterministic fallback: a gate fabricated from raw intel has no judgment and
  // ships noise (file paths, `make dev`, publish targets, every build variant). An
  // honest `failed` state the operator can re-trigger is better. Surface the reason
  // — enriched with whatever the stream revealed (e.g. an overloaded model API) —
  // and keep the gathered intel for transparency.
  if (agentError === null) {
    agentError = `Agent did not return valid output after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastErrors.join("; ")}`;
  }
  const failureSummary = summarizeAgentFailure(lastTurnLog);
  if (failureSummary !== null) agentError = `${agentError} — ${failureSummary}`;
  return stampAndStore(
    root,
    project.id,
    { status: "failed", checks: [], error: agentError, intel },
    project.repoPath
  );
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
    .catch(async (err) => {
      // generateProjectQualityGate resolves for every code path except a throw from
      // its terminal persist (stampAndStore -> writeQualityGate). Surface that as a
      // terminal `failed` state instead of swallowing it: a swallowed rejection leaves
      // the gate at `generating` forever, and planProjectChecks maps a non-ready gate
      // to a silent no-checks pass, so the project quietly runs no quality gate with
      // no error surfaced. The error-write is best-effort: if the filesystem is broken
      // outright the write may also fail, in which case reconcileStaleQualityGates
      // picks the orphaned `generating` gate up on the next daemon tick.
      const failed: QualityGateFile = {
        status: "failed",
        checks: [],
        error: `Quality-gate generation failed: ${(err as Error).message}`
      };
      await writeQualityGate(root, project.id, failed).catch(() => {});
    })
    .finally(() => activeGenerations.delete(key));
}

/**
 * Re-kick any project whose gate is still `generating` but not driven by this
 * process. Generation is fire-and-forget with an in-memory in-flight guard, so a
 * process restart mid-generation (or a generation whose terminal write threw and was
 * not recoverable in place) leaves the gate at `generating` on disk with nothing
 * moving it to a terminal state; planProjectChecks then maps it to a silent
 * no-checks pass, so the project quietly runs no quality gate forever. This sweep
 * re-kicks such orphaned gates: a gate that reads `generating` yet is not in the
 * in-flight guard has no driver in this process. Returns the number re-kicked. Safe
 * to call each daemon tick: startProjectQualityGate's guard prevents double-kicking
 * a genuinely active generation, and the re-kick refreshes that guard.
 */
export async function reconcileStaleQualityGates(
  root: string,
  options?: GenerateQualityGateOptions
): Promise<number> {
  const projects = await listProjects(root).catch(() => []);
  let reKicked = 0;
  for (const project of projects) {
    const gate = await readProjectQualityGate(root, project.id);
    if (gate.status !== "generating") continue;
    if (isGenerationActive(root, project.id)) continue;
    void startProjectQualityGate(root, project, options);
    reKicked++;
  }
  return reKicked;
}
