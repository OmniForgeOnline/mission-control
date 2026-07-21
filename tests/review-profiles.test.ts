import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  buildReviewerPrompt,
  gatherReviewContext,
  parseReviewerVerdict,
  type ReviewContext
} from "../src/core/review/code-review.ts";
import { gatherReviewSupportingEvidence } from "../src/core/review/supporting-evidence.ts";
import {
  PROFILE_CONSEQUENTIAL,
  resolveReviewerIndependence,
  resolveReviewProfile,
  type ReviewProfileId
} from "../src/core/review/profiles.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import type { HarnessTask } from "../src/core/types.ts";
import type { WorkflowStep } from "../src/core/workflows/types.ts";
import { loadEvalCorpus } from "../src/core/evals/load.ts";
import { inventoryWorkflows } from "../src/core/inventory/workflows.ts";
import { replayEvalCase } from "../src/core/baseline/replay.ts";

const CORPUS_ARTIFACT = `## Workflow maturity launch

Teams ship faster when workflows declare explicit maturity labels. Our rollout increased
adoption by **300%** last quarter and now reaches **10 million** active operators.

The narrative is polished, well structured, and ready for publication.`;

const CORPUS_EVIDENCE = `Redacted inventory snapshot:
- Q1 active operators: 2.1M
- Q2 active operators: 2.4M
- QoQ change: +14%`;

function baseTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "9b4de099-a5ff-40e0-9410-86cca1902b7e",
    title: "Launch maturity blog post",
    description: "Draft a launch post with verified metrics.",
    agent: "claude",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    reviewState: "none",
    turnCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function reviewContext(authorReply = CORPUS_ARTIFACT): ReviewContext {
  return {
    workspace: { cwd: "/tmp/scratch", isRepo: false },
    commitSubjects: [],
    changedFiles: ["launch-post.md"],
    diffStat: "",
    diff: "",
    diffTruncated: false,
    prefetchedFiles: `### launch-post.md\n\`\`\`\n${authorReply}\n\`\`\``,
    authorReply,
    checksNote: "Mechanical checks passed before this review (workflow advanced past checks).",
    mergeRequestNote: ""
  };
}

function reviewStep(profile?: ReviewProfileId, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "review",
    kind: "review",
    agent: "reviewer",
    approval: "none",
    ...(profile ? { reviewProfile: profile } : {}),
    ...overrides
  };
}

describe("review profiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-review-profiles-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults review steps without an explicit profile to code", () => {
    expect(resolveReviewProfile(reviewStep())).toBe("code");
  });

  it("resolves explicit workflow review profiles", () => {
    expect(resolveReviewProfile(reviewStep("content"))).toBe("content");
    expect(resolveReviewProfile(reviewStep("data"))).toBe("data");
  });

  it("defaults reviewer independence on for consequential profiles", () => {
    for (const profile of ["code", "data", "incident", "support", "decision"] as const) {
      expect(PROFILE_CONSEQUENTIAL[profile]).toBe(true);
      expect(resolveReviewerIndependence(reviewStep(profile))).toBe(true);
    }
    expect(resolveReviewerIndependence(reviewStep("content", { reviewerIndependence: false }))).toBe(
      false
    );
  });

  it("buildReviewerPrompt keeps diff-anchored standards for the code profile", () => {
    const prompt = buildReviewerPrompt({
      task: baseTask(),
      authorAgent: "grok",
      context: reviewContext(),
      profile: "code"
    });

    expect(prompt).toContain("Focus findings on **changed lines** in the diff");
    expect(prompt).toContain("Diff against base branch");
    expect(prompt).toContain("confidence ≥ 0.85");
    expect(prompt).toContain("Review profile: `code`");
  });

  it("buildReviewerPrompt omits code-diff rubric for the content profile", () => {
    const prompt = buildReviewerPrompt({
      task: baseTask(),
      authorAgent: "kiro",
      context: reviewContext(),
      profile: "content"
    });

    expect(prompt).toContain("Review profile: `content`");
    expect(prompt).toContain("source or fact verification");
    expect(prompt).toContain("Flag unsourced factual claims");
    expect(prompt).not.toContain("Focus findings on **changed lines** in the diff");
    expect(prompt).not.toContain("Diff against base branch");
    expect(prompt).toContain("Target artifact");
  });

  it("buildReviewerPrompt requires numeric reconciliation for the data profile", () => {
    const prompt = buildReviewerPrompt({
      task: baseTask({ title: "Usage distribution memo" }),
      authorAgent: "claude",
      context: reviewContext(),
      profile: "data",
      supportingEvidence: CORPUS_EVIDENCE
    });

    expect(prompt).toContain("Review profile: `data`");
    expect(prompt).toContain("reconciled against bounded supporting evidence");
    expect(prompt).toContain("Redacted inventory snapshot");
    expect(prompt).not.toContain("Focus findings on **changed lines** in the diff");
  });

  it("buildReviewerPrompt includes gathered supporting evidence for non-code profiles", () => {
    const task = baseTask({
      description: "Draft a launch post.\n\n## Plan\n\nVerify metrics against inventory exports.",
      links: [{ label: "Inventory", url: "https://example.com/inventory" }],
      attachments: [
        {
          id: "att-inventory",
          filename: "inventory.csv",
          mimeType: "text/csv",
          size: 1024,
          source: "intake",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      messages: [
        {
          id: "msg-research",
          author: "agent",
          body: "Research notes: inventory exports cover Q1–Q2 only.",
          createdAt: "2026-01-01T00:00:00.000Z",
          stepId: "research"
        }
      ],
      workflowRun: {
        workflowId: "blog-post",
        currentStepId: "editorial_review",
        completedSteps: ["research", "draft"],
        stepApprovals: {}
      }
    });
    const evidence = gatherReviewSupportingEvidence({
      task,
      step: reviewStep("content", { entryContext: "Blog launch Q2" }),
      harnessRoot: root,
      excludeAuthorReply: CORPUS_ARTIFACT
    });

    expect(evidence).toContain("Approved plan");
    expect(evidence).toContain("inventory.csv");
    expect(evidence).toContain("Research notes");

    const prompt = buildReviewerPrompt({
      task,
      authorAgent: "kiro",
      context: reviewContext(),
      step: reviewStep("content"),
      supportingEvidence: evidence
    });

    expect(prompt).toContain("## Bounded supporting evidence");
    expect(prompt).toContain("Blog launch Q2");
    expect(prompt).toContain("inventory.csv");
    expect(prompt).not.toContain("Diff against base branch");
  });

  it("parseReviewerVerdict handles phase-0 corpus-style data integrity findings", () => {
    const verdict = parseReviewerVerdict(`\`\`\`json
{
  "decision": "request_changes",
  "summary": "Metrics are not reconciled with supporting evidence.",
  "comments": [
    {
      "severity": "HIGH",
      "category": "DATA_INTEGRITY",
      "confidence": 0.95,
      "title": "Unsupported numeric claim",
      "rationale": "The stated metric cannot be reconciled with bounded supporting evidence.",
      "evidence": "300%"
    }
  ]
}
\`\`\``);

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.comments.some((comment) => comment.category === "DATA_INTEGRITY")).toBe(true);
  });

  it("loads bundled workflows with artifact-appropriate review profiles", async () => {
    const blog = await loadWorkflow(root, "blog-post");
    expect(blog.steps["editorial_review"]?.reviewProfile).toBe("content");
    expect(blog.steps["editorial_review"]?.skill).not.toBe("code-review");

    const dataAnalysis = await loadWorkflow(root, "data-analysis");
    expect(dataAnalysis.steps["review"]?.reviewProfile).toBe("data");
    expect(dataAnalysis.steps["review"]?.skill).toBe("data-analysis");

    const incident = await loadWorkflow(root, "incident-response");
    expect(incident.steps["review"]?.reviewProfile).toBe("incident");
    expect(incident.steps["review"]?.skill).toBe("incident-response");

    const support = await loadWorkflow(root, "customer-support");
    expect(support.steps["review"]?.reviewProfile).toBe("support");
    expect(support.steps["review"]?.skill).toBe("customer-support-triage");

    const codeFeature = await loadWorkflow(root, "code-feature");
    expect(codeFeature.steps["review"]?.reviewProfile).toBe("code");

    const frontend = await loadWorkflow(root, "frontend-ui-change");
    expect(frontend.steps["review"]?.reviewProfile).toBe("frontend");

    const docs = await loadWorkflow(root, "docs-update");
    expect(docs.steps["review"]?.reviewProfile).toBe("technical-doc");

    const spec = await loadWorkflow(root, "product-spec");
    expect(spec.steps["review_spec"]?.reviewProfile).toBe("decision");
  });

  it("replays the same artifact under code, content, and data review profiles", async () => {
    const corpus = await loadEvalCorpus();
    const cases = [
      "profiled-release-brief-code",
      "profiled-release-brief-content",
      "profiled-release-brief-data"
    ].map((id) => corpus.cases.find((entry) => entry.case?.id === id)?.case);
    expect(cases.every(Boolean)).toBe(true);
    expect(new Set(cases.map((entry) => entry!.inputs.targets?.[0]?.path)).size).toBe(1);
    const { runtimeDefinitions } = await inventoryWorkflows(root);
    const results = [];
    for (const entry of cases) results.push(await replayEvalCase(entry!, runtimeDefinitions, root));
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.map((result) => result.runtime?.reviewerDecisions[0])).toEqual([
      "approved",
      "approved",
      "changes_requested"
    ]);
  });

  it("gathers bounded supporting evidence for non-repo review workspaces", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "harness-review-scratch-"));
    try {
      await writeFile(path.join(scratch, "launch-post.md"), CORPUS_ARTIFACT, "utf8");
      const context = await gatherReviewContext({
        task: baseTask(),
        workspace: { cwd: scratch, isRepo: false, created: true },
        gitState: null,
        authorReply: CORPUS_ARTIFACT
      });

      expect(context.changedFiles.length).toBeGreaterThan(0);
      expect(context.prefetchedFiles).toContain(CORPUS_ARTIFACT.slice(0, 40));
      expect(context.diff).toBe("");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
