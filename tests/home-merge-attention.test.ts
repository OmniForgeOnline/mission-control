import { awaitingMergeTasks, mergeAttentionState } from "../src/ui/features/home/selectors.ts";
import type { HarnessTask } from "../src/ui/app/types.ts";

function task(id: string, overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("home awaiting-merge data mapping", () => {
  it("surfaces open and closed-without-merge MRs, excludes merged and MR-less work", () => {
    const open = task("open", {
      mergeRequest: { provider: "github", url: "https://github.com/acme/r/pull/1", number: 1, state: "open" }
    });
    const closed = task("closed", {
      mergeRequest: { provider: "gitlab", url: "https://gitlab.com/g/p/-/merge_requests/2", number: 2, state: "closed" }
    });
    const merged = task("merged", {
      resolution: "completed",
      completedAt: "2026-01-02T00:00:00.000Z",
      mergeRequest: {
        provider: "github",
        url: "https://github.com/acme/r/pull/3",
        number: 3,
        state: "merged",
        mergedAt: "2026-01-02T00:00:00.000Z"
      }
    });
    const noMr = task("none");

    const awaiting = awaitingMergeTasks([merged, noMr, open, closed]);
    expect(awaiting.map((t) => t.id)).toEqual(["closed", "open"]);
  });

  it("orders closed-without-merge before open, then by recency within each group", () => {
    const older = task("older", {
      createdAt: "2026-01-01T00:00:00.000Z",
      mergeRequest: { provider: "github", url: "u", number: 1, state: "open" }
    });
    const newer = task("newer", {
      createdAt: "2026-02-01T00:00:00.000Z",
      mergeRequest: { provider: "github", url: "u", number: 2, state: "open" }
    });
    const closed = task("closed", {
      createdAt: "2026-03-01T00:00:00.000Z",
      mergeRequest: { provider: "github", url: "u", number: 3, state: "closed" }
    });

    const awaiting = awaitingMergeTasks([older, newer, closed]);
    // Closed first; within open, newer before older (recency desc).
    expect(awaiting.map((t) => t.id)).toEqual(["closed", "newer", "older"]);
  });

  it("labels closed-without-merge distinctly from awaiting merge", () => {
    const closed = task("c", {
      mergeRequest: { provider: "github", url: "u", number: 1, state: "closed" }
    });
    const open = task("o", {
      mergeRequest: { provider: "github", url: "u", number: 2, state: "open" }
    });
    expect(mergeAttentionState(closed)).toEqual({ label: "Closed without merge", tone: "closed" });
    expect(mergeAttentionState(open)).toEqual({ label: "Awaiting merge", tone: "open" });
  });

  it("returns empty when every MR has landed", () => {
    const merged = task("m", {
      mergeRequest: { provider: "github", url: "u", number: 1, state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" }
    });
    expect(awaitingMergeTasks([merged])).toEqual([]);
  });
});
