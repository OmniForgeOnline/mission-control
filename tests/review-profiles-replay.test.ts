import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createReplayTemplateRoot, replayEvalCase } from "../src/core/baseline/replay.ts";
import { loadEvalCorpus } from "../src/core/evals/load.ts";
import { inventoryWorkflows } from "../src/core/inventory/workflows.ts";
import { resetWorkflowCache } from "../src/core/workflows/cache.ts";

/**
 * Full eval replay across review profiles — moved out of the default suite
 * because three parallel replay pipelines dominate wall clock (~20s).
 */
describe("review profile replay", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-review-replay-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
    const templateRoot = await createReplayTemplateRoot(root);
    try {
      const results = await Promise.all(
        cases.map((entry) => replayEvalCase(entry!, runtimeDefinitions, root, templateRoot))
      );
      expect(results.every((result) => result.passed)).toBe(true);
      expect(results.map((result) => result.runtime?.reviewerDecisions[0])).toEqual([
        "approved",
        "approved",
        "changes_requested"
      ]);
    } finally {
      resetWorkflowCache(templateRoot);
      await rm(templateRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
