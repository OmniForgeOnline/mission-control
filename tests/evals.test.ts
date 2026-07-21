import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUNDLED_WORKFLOW_IDS } from "../src/core/workflows/types.ts";
import type { EvalTaskClass } from "../src/core/evals/types.ts";
import {
  bundledEvalCorpusDir,
  loadEvalCorpus,
  loadEvalCaseFile,
  validateEvalCase,
  isRegisteredEvalCheckKind
} from "../src/core/evals/index.ts";

function minimalCase(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "test-case",
    workflowId: "bugfix",
    taskClass: "small",
    inputs: {
      title: "Fix null payload crash",
      description: "Guard empty API payloads before JSON parse."
    },
    permittedTools: ["claude", "codex"],
    outcome: {
      artifact: { kind: "code-change" },
      deterministicChecks: [{ kind: "checks-outcome", outcome: "validated" }]
    },
    risk: "low",
    provenance: {
      kind: "synthetic",
      source: "redacted fixture"
    },
    ...overrides
  };
}

describe("eval case schema", () => {
  it("accepts a minimal valid case", () => {
    const result = validateEvalCase(minimalCase(), new Set(BUNDLED_WORKFLOW_IDS));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.case.id).toBe("test-case");
      expect(result.case.workflowId).toBe("bugfix");
    }
  });

  it("rejects unknown workflow ids", () => {
    const result = validateEvalCase(
      minimalCase({ workflowId: "legal-review" }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("not a bundled workflow");
    }
  });

  it("rejects empty outcome objects", () => {
    const result = validateEvalCase(
      minimalCase({ outcome: {} }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("outcome");
    }
  });

  it("rejects synthetic cases without synthetic provenance", () => {
    const result = validateEvalCase(
      minimalCase({
        taskClass: "synthetic",
        provenance: { kind: "historical", source: "oops" }
      }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown deterministic check kinds", () => {
    const result = validateEvalCase(
      minimalCase({
        outcome: {
          artifact: { kind: "code-change" },
          deterministicChecks: [{ kind: "unknown-check-kind" }]
        }
      }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("not a registered eval check kind");
    }
    expect(isRegisteredEvalCheckKind("unknown-check-kind")).toBe(false);
    expect(isRegisteredEvalCheckKind("reviewer-verdict")).toBe(true);
  });

  it("accepts synthetic provenance for small, medium, and failure task classes", () => {
    const result = validateEvalCase(
      minimalCase({
        taskClass: "small",
        provenance: { kind: "synthetic", source: "pattern-synthesized fixture" }
      }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(true);
  });

  it("accepts integration-only cases when explicitly flagged", () => {
    const result = validateEvalCase(
      minimalCase({
        integrationOnly: true,
        inputs: {
          title: "Needs live forge",
          description: "Requires network access to verify MR state.",
          context: { requiresNetwork: "true" }
        }
      }),
      new Set(BUNDLED_WORKFLOW_IDS)
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.case.integrationOnly).toBe(true);
    }
  });
});

describe("eval corpus loading", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "harness-evals-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("loads and validates every bundled v1 case fixture", async () => {
    const corpus = await loadEvalCorpus();
    expect(corpus.version).toBe("v1");
    expect(corpus.cases.length).toBeGreaterThan(0);

    const byWorkflow = new Map<string, number>();
    for (const entry of corpus.cases) {
      expect(entry.errors).toEqual([]);
      expect(entry.case).not.toBeNull();
      if (!entry.case) continue;
      byWorkflow.set(entry.case.workflowId, (byWorkflow.get(entry.case.workflowId) ?? 0) + 1);
    }

    for (const workflowId of BUNDLED_WORKFLOW_IDS) {
      expect(byWorkflow.get(workflowId)).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers representative workflows with small, medium, and failure classes", async () => {
    const corpus = await loadEvalCorpus();
    const historical = ["code-feature", "bugfix", "frontend-ui-change", "product-spec"] as const;
    const required = new Set<EvalTaskClass>(["small", "medium", "failure"]);

    for (const workflowId of historical) {
      const classes = new Set(
        corpus.cases
          .filter((entry) => entry.case?.workflowId === workflowId)
          .map((entry) => entry.case!.taskClass)
      );
      for (const taskClass of required) {
        expect(classes.has(taskClass)).toBe(true);
      }
    }
  });

  it("includes long review-loop decomposition and acceptance-contract cases", async () => {
    const corpus = await loadEvalCorpus();
    const decomposition = corpus.cases.find(
      (entry) =>
        entry.case?.workflowId === "code-feature" &&
        entry.case.id === "long-review-loop" &&
        entry.case.taskClass === "decomposition"
    );
    const acceptance = corpus.cases.find(
      (entry) =>
        entry.case?.workflowId === "code-feature" &&
        entry.case.id === "locale-acceptance-contract" &&
        entry.case.taskClass === "acceptance-contract"
    );
    expect(decomposition).toBeDefined();
    expect(acceptance).toBeDefined();
    if (decomposition?.case) {
      const checks = decomposition.case.outcome.deterministicChecks ?? [];
      expect(checks.some((c) => c.kind === "workflow-step")).toBe(true);
      expect((decomposition.case.outcome.rubric ?? []).length).toBeGreaterThan(0);
      expect(decomposition.case.provenance.kind).toBe("synthetic");
    }
    if (acceptance?.case) {
      expect((acceptance.case.outcome.rubric ?? []).some((item) => item.id === "forbidden")).toBe(true);
    }
  });

  it("rejects duplicate case ids in a corpus directory", async () => {
    const caseDir = path.join(tempRoot, "cases", "v1", "bugfix");
    await mkdir(caseDir, { recursive: true });
    const firstPath = path.join(caseDir, "first.json");
    const secondPath = path.join(caseDir, "duplicate.json");
    const payload = JSON.stringify(minimalCase({ id: "duplicate-id" }), null, 2);
    await writeFile(firstPath, payload, "utf8");
    await writeFile(secondPath, payload, "utf8");

    const corpus = await loadEvalCorpus({ root: path.join(tempRoot, "cases", "v1") });
    const invalid = corpus.cases.filter((entry) => entry.errors.length > 0);
    expect(invalid.length).toBe(1);
    expect(invalid[0]?.errors.join(" ")).toContain('Duplicate case id "duplicate-id"');
  });

  it("labels unexercised workflows with synthetic provenance", async () => {
    const corpus = await loadEvalCorpus();
    const exercised = new Set([
      "code-feature",
      "bugfix",
      "frontend-ui-change",
      "product-spec",
      "blog-post",
      "data-analysis"
    ]);
    const syntheticOnly = BUNDLED_WORKFLOW_IDS.filter((id) => !exercised.has(id));

    for (const workflowId of syntheticOnly) {
      const cases = corpus.cases.filter((entry) => entry.case?.workflowId === workflowId);
      expect(cases.length).toBeGreaterThanOrEqual(1);
      expect(cases.every((entry) => entry.case?.provenance.kind === "synthetic")).toBe(true);
      expect(cases.every((entry) => entry.case?.taskClass === "synthetic")).toBe(true);
    }
  });

  it("loads a case file from a custom corpus directory", async () => {
    const caseDir = path.join(tempRoot, "cases", "v1", "bugfix");
    await mkdir(caseDir, { recursive: true });
    const casePath = path.join(caseDir, "custom.json");
    await writeFile(casePath, JSON.stringify(minimalCase({ id: "custom" }), null, 2), "utf8");

    const loaded = await loadEvalCaseFile(casePath, new Set(BUNDLED_WORKFLOW_IDS));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.case.id).toBe("custom");
    }
  });

  it("resolves bundled corpus dir relative to package root", () => {
    expect(bundledEvalCorpusDir()).toMatch(/tests\/evals\/cases\/v1$/);
  });
});
