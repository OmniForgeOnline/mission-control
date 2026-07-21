import { isRegisteredEvalCheckKind } from "./check-kinds.ts";
import { asRecord } from "../infra/record.ts";
import { redactValue } from "../inventory/redact.ts";
import type {
  ChecksOutcome,
  EvalArtifact,
  EvalCase,
  EvalDeterministicCheck,
  EvalInputs,
  EvalOutcome,
  EvalProvenance,
  EvalProvenanceKind,
  EvalReplay,
  EvalReplayFixtures,
  EvalRisk,
  EvalRubricItem,
  EvalTarget,
  EvalTaskClass,
  EvalValidationResult,
  ReviewDecision
} from "./types.ts";

const TASK_CLASSES = new Set<EvalTaskClass>([
  "small",
  "medium",
  "failure",
  "synthetic",
  "decomposition",
  "acceptance-contract"
]);

const RISK_LEVELS = new Set<EvalRisk>(["low", "medium", "high"]);
const PROVENANCE_KINDS = new Set<EvalProvenanceKind>(["historical", "synthetic"]);
const REVIEW_DECISIONS = new Set<ReviewDecision>(["approved", "changes_requested", "comment"]);
const CHECKS_OUTCOMES = new Set<ChecksOutcome>(["validated", "failed", "noChecks"]);
const TARGET_KINDS = new Set<EvalTarget["kind"]>(["file", "directory"]);

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array of strings.`);
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    const text = trimmedString(entry);
    if (!text) {
      errors.push(`${label} entries must be non-empty strings.`);
      continue;
    }
    items.push(text);
  }
  return items;
}

function parseTargets(raw: unknown, errors: string[]): EvalTarget[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push("inputs.targets must be an array.");
    return undefined;
  }
  const targets: EvalTarget[] = [];
  for (const entry of raw) {
    const doc = asRecord(entry, "inputs.targets[]", { orNull: true });
    if (!doc) {
      errors.push("inputs.targets entries must be objects.");
      continue;
    }
    const targetPath = trimmedString(doc["path"]);
    const kindRaw = trimmedString(doc["kind"]);
    if (!targetPath) errors.push("inputs.targets[].path must be a non-empty string.");
    if (!TARGET_KINDS.has(kindRaw as EvalTarget["kind"])) {
      errors.push('inputs.targets[].kind must be "file" or "directory".');
    }
    if (targetPath && TARGET_KINDS.has(kindRaw as EvalTarget["kind"])) {
      targets.push({ path: targetPath, kind: kindRaw as EvalTarget["kind"] });
    }
  }
  return targets;
}

function parseContext(raw: unknown, errors: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const doc = asRecord(raw, "inputs.context", { orNull: true });
  if (!doc) {
    errors.push("inputs.context must be an object.");
    return undefined;
  }
  const context: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value !== "string") {
      errors.push(`inputs.context.${key} must be a string.`);
      continue;
    }
    context[key] = value;
  }
  return context;
}

function parseInputs(raw: unknown, errors: string[]): EvalInputs | null {
  const doc = asRecord(raw, "inputs", { orNull: true });
  if (!doc) {
    errors.push("inputs must be an object.");
    return null;
  }
  const title = trimmedString(doc["title"]);
  const description = trimmedString(doc["description"]);
  if (!title) errors.push("inputs.title must be a non-empty string.");
  if (!description) errors.push("inputs.description must be a non-empty string.");
  const targets = parseTargets(doc["targets"], errors);
  const context = parseContext(doc["context"], errors);
  if (!title || !description) return null;
  return {
    title,
    description,
    ...(targets ? { targets } : {}),
    ...(context ? { context } : {})
  };
}

function parseArtifact(raw: unknown, errors: string[]): EvalArtifact | undefined {
  const doc = asRecord(raw, "outcome.artifact", { orNull: true });
  if (!doc) return undefined;
  const kind = trimmedString(doc["kind"]);
  if (!kind) errors.push("outcome.artifact.kind must be a non-empty string.");
  const pathPattern = trimmedString(doc["pathPattern"]) || undefined;
  const requiredSections = Array.isArray(doc["requiredSections"])
    ? doc["requiredSections"].map((entry) => trimmedString(entry)).filter(Boolean)
    : undefined;
  if (!kind) return undefined;
  return {
    kind,
    ...(pathPattern ? { pathPattern } : {}),
    ...(requiredSections?.length ? { requiredSections } : {})
  };
}

function parseDeterministicChecks(raw: unknown, errors: string[]): EvalDeterministicCheck[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push("outcome.deterministicChecks must be an array.");
    return undefined;
  }
  const checks: EvalDeterministicCheck[] = [];
  for (const entry of raw) {
    const doc = asRecord(entry, "outcome.deterministicChecks[]", { orNull: true });
    if (!doc) {
      errors.push("outcome.deterministicChecks entries must be objects.");
      continue;
    }
    const kind = trimmedString(doc["kind"]);
    if (!isRegisteredEvalCheckKind(kind)) {
      errors.push(`outcome.deterministicChecks[].kind "${kind}" is not a registered eval check kind.`);
      continue;
    }
    const check: EvalDeterministicCheck = { kind };
    if (kind === "reviewer-verdict") {
      const decision = trimmedString(doc["decision"]) as ReviewDecision;
      if (!REVIEW_DECISIONS.has(decision)) {
        errors.push('reviewer-verdict checks require decision "approved", "changes_requested", or "comment".');
        continue;
      }
      check.decision = decision;
    } else if (kind === "checks-outcome") {
      const outcome = trimmedString(doc["outcome"]) as ChecksOutcome;
      if (!CHECKS_OUTCOMES.has(outcome)) {
        errors.push('checks-outcome checks require outcome "validated", "failed", or "noChecks".');
        continue;
      }
      check.outcome = outcome;
    } else if (kind === "workflow-step") {
      const stepId = trimmedString(doc["stepId"]);
      if (!stepId) {
        errors.push("workflow-step checks require stepId.");
        continue;
      }
      check.stepId = stepId;
    } else if (kind === "artifact-present") {
      const pathPattern = trimmedString(doc["pathPattern"]);
      if (!pathPattern) {
        errors.push("artifact-present checks require pathPattern.");
        continue;
      }
      check.pathPattern = pathPattern;
    }
    checks.push(check);
  }
  return checks;
}

function parseRubric(raw: unknown, errors: string[]): EvalRubricItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push("outcome.rubric must be an array.");
    return undefined;
  }
  const rubric: EvalRubricItem[] = [];
  for (const entry of raw) {
    const doc = asRecord(entry, "outcome.rubric[]", { orNull: true });
    if (!doc) {
      errors.push("outcome.rubric entries must be objects.");
      continue;
    }
    const id = trimmedString(doc["id"]);
    const criterion = trimmedString(doc["criterion"]);
    if (!id) errors.push("outcome.rubric[].id must be a non-empty string.");
    if (!criterion) errors.push("outcome.rubric[].criterion must be a non-empty string.");
    const weightRaw = doc["weight"];
    const weight = typeof weightRaw === "number" && Number.isFinite(weightRaw) ? weightRaw : undefined;
    if (id && criterion) {
      rubric.push({ id, criterion, ...(weight !== undefined ? { weight } : {}) });
    }
  }
  return rubric;
}

function parseOutcome(raw: unknown, errors: string[]): EvalOutcome | null {
  const doc = asRecord(raw, "outcome", { orNull: true });
  if (!doc) {
    errors.push("outcome must be an object.");
    return null;
  }
  const artifact = parseArtifact(doc["artifact"], errors);
  const deterministicChecks = parseDeterministicChecks(doc["deterministicChecks"], errors);
  const rubric = parseRubric(doc["rubric"], errors);
  if (!artifact && !deterministicChecks?.length && !rubric?.length) {
    errors.push("outcome must define artifact, deterministicChecks, or rubric.");
    return null;
  }
  return {
    ...(artifact ? { artifact } : {}),
    ...(deterministicChecks?.length ? { deterministicChecks } : {}),
    ...(rubric?.length ? { rubric } : {})
  };
}

function parseProvenance(raw: unknown, errors: string[]): EvalProvenance | null {
  const doc = asRecord(raw, "provenance", { orNull: true });
  if (!doc) {
    errors.push("provenance must be an object.");
    return null;
  }
  const kindRaw = trimmedString(doc["kind"]);
  const kind = PROVENANCE_KINDS.has(kindRaw as EvalProvenanceKind)
    ? (kindRaw as EvalProvenanceKind)
    : null;
  if (!kind) errors.push('provenance.kind must be "historical" or "synthetic".');
  const source = trimmedString(doc["source"]);
  if (!source) errors.push("provenance.source must be a non-empty string.");
  const notes = trimmedString(doc["notes"]) || undefined;
  const redactions = Array.isArray(doc["redactions"])
    ? doc["redactions"].map((entry) => trimmedString(entry)).filter(Boolean)
    : undefined;
  if (!kind || !source) return null;
  return {
    kind,
    source,
    ...(notes ? { notes } : {}),
    ...(redactions?.length ? { redactions } : {})
  };
}

function parseReplayFixtures(raw: unknown, _errors: string[]): EvalReplayFixtures | undefined {
  const doc = asRecord(raw, "replay.fixtures", { orNull: true });
  if (!doc) return undefined;
  const reviewerReply = trimmedString(doc["reviewerReply"]) || undefined;
  const artifactPaths = Array.isArray(doc["artifactPaths"])
    ? doc["artifactPaths"].map((entry) => trimmedString(entry)).filter(Boolean)
    : undefined;
  const workspacePath = trimmedString(doc["workspacePath"]) || undefined;
  if (!reviewerReply && !artifactPaths?.length && !workspacePath) return undefined;
  return {
    ...(reviewerReply ? { reviewerReply } : {}),
    ...(artifactPaths?.length ? { artifactPaths } : {}),
    ...(workspacePath ? { workspacePath } : {})
  };
}

function parseReplay(raw: unknown, errors: string[]): EvalReplay | undefined {
  if (raw === undefined) return undefined;
  const doc = asRecord(raw, "replay", { orNull: true });
  if (!doc) {
    errors.push("replay must be an object when present.");
    return undefined;
  }
  const fixtures = parseReplayFixtures(doc["fixtures"], errors);
  return fixtures ? { fixtures } : {};
}

function validateProvenanceAlignment(taskClass: EvalTaskClass, provenance: EvalProvenance, errors: string[]): void {
  if (taskClass === "synthetic" && provenance.kind !== "synthetic") {
    errors.push('taskClass "synthetic" requires provenance.kind "synthetic".');
  }
}

export function validateEvalCase(
  raw: unknown,
  workflowIds: ReadonlySet<string>
): EvalValidationResult {
  const redacted = redactValue(raw);
  const errors: string[] = [];
  const doc = asRecord(redacted, "root", { orNull: true });
  if (!doc) {
    return { ok: false, errors: ["Case must be a single JSON object."] };
  }

  if (doc["schemaVersion"] !== 1) {
    errors.push("schemaVersion must be 1.");
  }

  const id = trimmedString(doc["id"]);
  if (!id) errors.push("id must be a non-empty string.");

  const workflowId = trimmedString(doc["workflowId"]);
  if (!workflowId) {
    errors.push("workflowId must be a non-empty string.");
  } else if (!workflowIds.has(workflowId)) {
    errors.push(`workflowId "${workflowId}" is not a bundled workflow.`);
  }

  const taskClassRaw = trimmedString(doc["taskClass"]);
  const taskClass = TASK_CLASSES.has(taskClassRaw as EvalTaskClass)
    ? (taskClassRaw as EvalTaskClass)
    : null;
  if (!taskClass) {
    errors.push("taskClass is invalid.");
  }

  const riskRaw = trimmedString(doc["risk"]);
  const risk = RISK_LEVELS.has(riskRaw as EvalRisk) ? (riskRaw as EvalRisk) : null;
  if (!risk) errors.push('risk must be "low", "medium", or "high".');

  const permittedTools = parseStringArray(doc["permittedTools"], "permittedTools", errors);
  const inputs = parseInputs(doc["inputs"], errors);
  const outcome = parseOutcome(doc["outcome"], errors);
  const provenance = parseProvenance(doc["provenance"], errors);
  const replay = parseReplay(doc["replay"], errors);

  if (taskClass && provenance) {
    validateProvenanceAlignment(taskClass, provenance, errors);
  }

  const integrationOnly = doc["integrationOnly"] === true ? true : undefined;
  if (doc["integrationOnly"] !== undefined && doc["integrationOnly"] !== true && doc["integrationOnly"] !== false) {
    errors.push("integrationOnly must be a boolean when present.");
  }

  if (errors.length || !id || !workflowId || !taskClass || !risk || !inputs || !outcome || !provenance) {
    return { ok: false, errors };
  }

  const evalCase: EvalCase = {
    schemaVersion: 1,
    id,
    workflowId,
    taskClass,
    inputs,
    permittedTools,
    outcome,
    risk,
    provenance,
    ...(replay ? { replay } : {}),
    ...(integrationOnly ? { integrationOnly } : {})
  };

  return { ok: true, case: evalCase };
}
