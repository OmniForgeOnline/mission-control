import path from "node:path";

import { asRecord } from "../infra/record.ts";
import { ensureDir, readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { emitStateChange } from "../infra/state-bus.ts";
import { type GateCategory, type ProjectIntel } from "./intel.ts";
import { inferCategoryFromToken } from "./intel-docs-ci.ts";
import { projectDir } from "./registry.ts";

/**
 * Lifecycle of a generated quality-gate config.
 *
 * - `pending`: onboarding has not generated a config yet (baseline detection runs).
 * - `generating`: an agent turn is in flight.
 * - `ready`: a project-specific, evidence-backed config drives the gate.
 * - `incomplete`: evidence was insufficient; the operator must resolve gaps. The
 *   system never substitutes a generic gate here.
 * - `failed`: generation could not gather intel at all (exceptional).
 */
export type QualityGateStatus = "pending" | "generating" | "ready" | "incomplete" | "failed";

/** A single evidence-backed quality-gate check. Tool-agnostic: no toolchain names. */
export interface QualityGateCheck {
  /** Human label, e.g. "lint" or "test". */
  name: string;
  /** What this check does, never which toolchain. */
  category: GateCategory;
  /** Shell invocation, e.g. "ruff check ." or "npm run -s test". */
  command: string;
  /** Optional working directory relative to the repo root. */
  workingDirectory?: string;
  /** When false the check is advisory (still recorded, does not fail the gate). */
  required: boolean;
  /** Concrete repo evidence backing this command (>= 1). */
  evidence: string[];
}

export interface QualityGateFile {
  status: QualityGateStatus;
  checks: QualityGateCheck[];
  /** Present when `status === "incomplete"`: gaps the operator must resolve. */
  needsResolution?: string[];
  /** Why the config is shaped this way (agent rationale or deterministic note). */
  rationale?: string;
  /** ISO timestamp the config was produced. */
  generatedAt?: string;
  /** Repo the config was generated against. */
  repoPath?: string;
  /** Why generation failed (`status === "failed"`). */
  error?: string;
  /** Snapshot of the intel that produced this config, for transparency. */
  intel?: ProjectIntel;
}

export const QUALITY_GATE_CHECK_MAX = 12;

function qualityGatePath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), "quality-gate.json");
}

/** Placeholder config returned before any generation has run. */
export function pendingQualityGate(): QualityGateFile {
  return {
    status: "pending",
    checks: [],
    needsResolution: ["Quality-gate config has not been generated for this project yet."]
  };
}

/** The stored config, or a `pending` placeholder when nothing has been generated. */
export async function readProjectQualityGate(root: string, projectId: string): Promise<QualityGateFile> {
  const stored = await readJsonFile<QualityGateFile | null>(qualityGatePath(root, projectId), null);
  if (stored && typeof stored.status === "string" && Array.isArray(stored.checks)) {
    return stored;
  }
  return pendingQualityGate();
}

/** Persist a quality-gate config under the project's state dir. */
export async function writeQualityGate(root: string, projectId: string, file: QualityGateFile): Promise<void> {
  await ensureDir(projectDir(root, projectId));
  await writeJsonFile(qualityGatePath(root, projectId), file);
  emitStateChange(["chrome"]);
}

const VALID_AGENT_STATUSES = new Set<QualityGateStatus>(["ready", "incomplete"]);
const VALID_CATEGORIES = new Set<GateCategory>([
  "lint",
  "test",
  "typecheck",
  "build",
  "format",
  "security",
  "other"
]);

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A safe `workingDirectory` is relative to the repo root and stays inside it.
 * Rejects absolute paths and any traversal that normalizes outside the root, so
 * agent-supplied input cannot relocate check execution (or the rendered `cd` in
 * the author prompt) beyond the task workspace. Interior `..` that folds back
 * inside the repo (e.g. `a/../b`) is allowed.
 */
export function isRepoRelativePath(input: string): boolean {
  if (path.isAbsolute(input)) return false;
  const normalized = path.normalize(input);
  if (normalized === "..") return false;
  return !normalized.startsWith(`..${path.sep}`);
}

/**
 * Shell syntax the check executor cannot honour: it spawns each command directly
 * (`shell: false`), passing the program and argv verbatim with no shell. An
 * unquoted operator is therefore passed as a literal argument and silently
 * mis-runs (an `&&` chain executes only the first stage; `cd x && c` fails to
 * spawn the `cd` builtin; pipes, redirections and substitution do nothing). An
 * operator that appears *inside* quotes is a literal argument and is fine, so the
 * scan is quote-aware. A leading `NAME=value` env assignment is rejected too: the
 * executor passes `env` only, never per-command assignments. A leading `cd` is
 * rejected as well: `cd` is a shell builtin, so spawning it directly either fails
 * or silently no-ops instead of changing the command's directory; a subdirectory
 * must be conveyed via `workingDirectory` instead.
 *
 * Returns a short label naming the first offending construct, or null when the
 * command is a single direct invocation. Enforced both at generation
 * ({@link parseAndValidateQualityGate}) and when a stored gate is re-read
 * ({@link gateCheckToPlanned}), mirroring {@link isRepoRelativePath}.
 */
export function findUnsupportedShellSyntax(command: string): string | null {
  const assignment = command.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(?!=)\S/);
  if (assignment?.[1]) return `leading ${assignment[1]}= assignment`;

  // `cd` is only meaningful as a shell builtin; spawned as a child it cannot move
  // the executor into a subdirectory, so a leading `cd <dir>` (with or without a
  // later operator) must be rejected in favour of `workingDirectory`. The word
  // boundary avoids matching programs that merely start with "cd".
  if (/^\s*cd(?:\s|$)/.test(command)) return "leading cd";

  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command.slice(i, i + 1);
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") return pair;
    if (pair === "$(" || pair === "${") return pair;
    if (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<" || ch === "`") return ch;
    if (ch === "\n") return "newline";
    if (ch === "\r") return "carriage return";
  }
  return null;
}

function extractJsonText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return fenced ?? null;
}

function evidenceFrom(entry: unknown): string[] | null {
  if (!Array.isArray(entry)) return null;
  const evidence = entry.map((item) => trimmed(item)).filter((item) => item.length > 0);
  return evidence.length > 0 ? evidence.slice(0, 5) : null;
}

/**
 * Parse and validate agent output into a quality-gate config. Enforces the
 * no-generic-fallback contract structurally: every check must carry concrete
 * evidence, a `ready` config must contain at least one such check, and an
 * `incomplete` config must name the gaps. A bare or fenced JSON object is accepted.
 */
export type QualityGateValidation =
  | { ok: true; file: QualityGateFile }
  | { ok: false; errors: string[] };

export function parseAndValidateQualityGate(raw: string): QualityGateValidation {
  const jsonText = extractJsonText(raw);
  if (!jsonText) {
    return { ok: false, errors: ["Response must be a JSON object with status, checks, and evidence."] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, errors: [`JSON parse error: ${(err as Error).message}`] };
  }

  const doc = asRecord(parsed, "quality-gate response", { orNull: true });
  if (!doc) {
    return { ok: false, errors: ["Expected a JSON object with status, checks, and evidence."] };
  }

  const status = trimmed(doc["status"]) as QualityGateStatus;
  if (!VALID_AGENT_STATUSES.has(status)) {
    return {
      ok: false,
      errors: [`status must be "ready" or "incomplete"; got "${status || "<missing>"}".`]
    };
  }

  if (!Array.isArray(doc["checks"])) {
    return { ok: false, errors: ["checks must be an array of evidence-backed check objects."] };
  }

  const checks: QualityGateCheck[] = [];
  const errors: string[] = [];
  for (const entry of doc["checks"] as unknown[]) {
    const check = asRecord(entry, "check", { orNull: true });
    if (!check) continue;
    const name = trimmed(check["name"]);
    const command = trimmed(check["command"]);
    const category = trimmed(check["category"]) as GateCategory;
    const evidence = evidenceFrom(check["evidence"]);
    if (!name || !command) continue;
    if (!VALID_CATEGORIES.has(category)) continue;
    if (!evidence) continue; // A check without concrete evidence is a generic guess — drop it.
    const shellSyntax = findUnsupportedShellSyntax(command);
    if (shellSyntax !== null) {
      // The executor spawns commands directly (no shell), so a shell-style command
      // would mis-run: `a && b` runs only `a`, `cd x && c` cannot spawn `cd`, and
      // pipes/redirections/substitution are passed as literal argv. Reject it here
      // so it is never persisted; the message drives the agent's correction turn.
      errors.push(
        `Check "${name}" command \`${command}\` uses shell syntax (\`${shellSyntax}\`) the executor cannot run. ` +
          "Emit a single direct invocation per check (no &&, ||, pipes, redirections, background &, command substitution, leading NAME=value, or cd). " +
          "Split a chain into separate checks and use workingDirectory to run from a subdirectory."
      );
      continue;
    }
    const built: QualityGateCheck = {
      name,
      category,
      command,
      required: check["required"] === false ? false : true,
      evidence
    };
    const workingDirectory = trimmed(check["workingDirectory"]);
    if (workingDirectory && isRepoRelativePath(workingDirectory)) built.workingDirectory = workingDirectory;
    checks.push(built);
  }

  if (errors.length > 0) return { ok: false, errors };

  if (status === "ready" && checks.length === 0) {
    return {
      ok: false,
      errors: [
        "A ready config must contain at least one check backed by concrete evidence. " +
          "If no evidence was found, return status \"incomplete\" with needsResolution instead."
      ]
    };
  }

  const file: QualityGateFile = {
    status,
    checks: checks.slice(0, QUALITY_GATE_CHECK_MAX)
  };

  const rationale = trimmed(doc["rationale"]);
  if (rationale) file.rationale = rationale;

  if (status === "incomplete") {
    const needsResolution = Array.isArray(doc["needsResolution"])
      ? (doc["needsResolution"] as unknown[]).map((item) => trimmed(item)).filter((item) => item.length > 0)
      : [];
    if (needsResolution.length === 0) {
      return {
        ok: false,
        errors: ['An incomplete config must list at least one gap in needsResolution.']
      };
    }
    file.needsResolution = needsResolution.slice(0, 10);
  }

  return { ok: true, file };
}

const CATEGORY_LABELS: Record<GateCategory, string> = {
  lint: "lint",
  test: "test",
  typecheck: "typecheck",
  build: "build",
  format: "format",
  security: "security",
  other: "check"
};

/**
 * Deterministically derive a quality-gate config from gathered intel. Used as the
 * safe fallback when the agent does not return valid output: it never fabricates a
 * gate. It folds every evidence source the intel layer gathered (manifest/Makefile
 * commands, CI run steps, and commands excerpted from docs) into `ready` checks,
 * vetting each for a single direct invocation (the executor spawns with no shell,
 * mirroring {@link parseAndValidateQualityGate}) and attaching its provenance as
 * evidence. When no source yields a runnable command it returns `incomplete` with
 * explicit gaps, never a generic gate.
 */
export function synthesizeGateFromIntel(intel: ProjectIntel): QualityGateFile {
  const checks: QualityGateCheck[] = [];
  const usedNames = new Map<string, number>();
  const seen = new Set<string>();

  /**
   * Add a vetted command as a check. A command is dropped (not emitted) when it is
   * a duplicate of one already added or when it relies on shell syntax the direct
   * executor cannot run. This is the same vetting enforced on agent output, so a
   * CI/docs chain like `a && b` is rejected here rather than persisted to mis-run.
   * Sources are walked highest confidence first: manifests/Makefile, then CI, then docs.
   */
  const addCheck = (command: string, category: GateCategory, source: string): void => {
    if (seen.has(command)) return;
    if (findUnsupportedShellSyntax(command) !== null) return;
    seen.add(command);
    const base = CATEGORY_LABELS[category] ?? "check";
    const count = usedNames.get(base) ?? 0;
    usedNames.set(base, count + 1);
    const name = count === 0 ? base : `${base}-${count + 1}`;
    checks.push({
      name,
      category,
      command,
      required: category !== "format",
      evidence: [source]
    });
  };

  for (const detected of intel.commands) {
    addCheck(detected.command, detected.category, detected.source);
  }
  for (const detected of intel.ci) {
    addCheck(detected.command, detected.category, detected.source);
  }
  for (const doc of intel.docs) {
    for (const command of doc.commands) {
      addCheck(command, inferCategoryFromToken(command), `docs ${doc.path}`);
    }
  }

  if (checks.length > 0) {
    return {
      status: "ready",
      checks,
      rationale:
        "Derived deterministically from repo evidence (manifests, Makefile, CI, docs). " +
        "No generic gate was assumed.",
      intel
    };
  }

  return {
    status: "incomplete",
    checks: [],
    needsResolution: [
      "No build/test/lint commands were discoverable from project markers, Makefile, docs, or CI.",
      "Declare how to lint, test, and build this repo (e.g. add scripts, a Makefile, or document commands)."
    ],
    rationale: "Insufficient evidence to generate a project-specific gate; no generic fallback applied.",
    intel
  };
}
