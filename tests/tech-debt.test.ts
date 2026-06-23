import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runTechDebtSweep } from "../src/autonomy/handlers/tech-debt-sweep.ts";
import { techDebtPath } from "../src/autonomy/job-types.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../src/core/infra/fs.ts";
import { proposalTools } from "../src/mcp/tools/proposals.ts";
import type { McpToolContext } from "../src/mcp/types.ts";

interface TechDebtItem {
  id: string;
  title: string;
  description: string;
  status?: "open" | "closed" | "queued";
}

describe("tech-debt ledger", () => {
  let root: string;
  let ctx: McpToolContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-tech-debt-"));
    await ensureHarnessRepository(root);
    ctx = { root, runId: "test-run" };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent tech_debt_capture calls without corrupting the ledger", async () => {
    const titles = Array.from({ length: 12 }, (_, index) => `Concurrent debt ${index + 1}`);

    const capture = proposalTools.handlers["tech_debt_capture"];
    if (!capture) {
      throw new Error("tech_debt_capture handler is not registered");
    }

    await Promise.all(
      titles.map((title) =>
        capture(ctx, {
          title,
          description: `Description for ${title}`
        })
      )
    );

    const ledgerPath = techDebtPath(root);
    const raw = await readFile(ledgerPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();

    const items = JSON.parse(raw) as TechDebtItem[];
    expect(items).toHaveLength(titles.length);
    for (const title of titles) {
      expect(items.some((item) => item.title === title && item.status === "open")).toBe(true);
    }

    const sweep = await runTechDebtSweep(root);
    expect(sweep.summary).not.toContain("No open tech-debt items");
  });

  it("updateJsonFile preserves all concurrent appends", async () => {
    const ledgerPath = path.join(root, "data", "state", "concurrent-append.json");
    const labels = Array.from({ length: 16 }, (_, index) => `item-${index}`);

    await Promise.all(
      labels.map((label) =>
        updateJsonFile<string[]>(ledgerPath, [], (current) => {
          current.push(label);
          return current;
        })
      )
    );

    const items = await readJsonFile<string[]>(ledgerPath, []);
    expect(items).toHaveLength(labels.length);
    for (const label of labels) {
      expect(items).toContain(label);
    }
  });

  it("does not steal a live holder's lock when its lock file is briefly empty", async () => {
    // A holder creates the lock file with O_EXCL before its metadata is written, so
    // a concurrent contender can momentarily read it back empty. That must not be
    // treated as a stale/missing lock, or the contender steals the lock, the two
    // critical sections overlap, and an update is lost. Pre-fix this cleared the
    // empty lock and the update below would succeed.
    const file = path.join(root, "data", "state", "empty-lock.json");
    await writeJsonFile(file, []);
    const lock = `${file}.lock`;
    await writeFile(lock, "");

    await expect(
      updateJsonFile<string[]>(
        file,
        [],
        (current) => [...current, "x"],
        { maxAttempts: 4, retryDelayMs: 5 }
      )
    ).rejects.toThrow(/acquiring lock/);

    // The young, empty lock must still be in place — it was not stolen.
    expect(await readFile(lock, "utf8")).toBe("");
  });
});