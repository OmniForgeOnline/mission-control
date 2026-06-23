import { describe, expect, it } from "vitest";

import {
  isMemoryPage,
  pageSlug,
  withoutPage
} from "../src/ui/features/memory/match.ts";
import type { MemoryPage } from "../src/ui/app/types.ts";

function page(partial: Partial<MemoryPage>): MemoryPage {
  return { ...partial } as MemoryPage;
}

describe("pageSlug", () => {
  it("prefers slug over path", () => {
    expect(pageSlug(page({ slug: "projects/app/plan", path: "projects/app/plan.md" }))).toBe(
      "projects/app/plan"
    );
  });

  it("falls back to path when slug is absent", () => {
    expect(pageSlug(page({ path: "projects/app/plan" }))).toBe("projects/app/plan");
  });

  it("is empty when neither slug nor path is set", () => {
    expect(pageSlug(page({}))).toBe("");
  });

  it("recovers the slug from a memory index hit via id", () => {
    // /api/memory/index/search returns memory documents with an indexed path and
    // `memory:<slug>` id but no slug; the DELETE/open key must be the slug, not
    // `memory/pages/<slug>.md` (which the backend normalizes into a 404).
    expect(
      pageSlug(
        page({ sourceType: "memory", id: "memory:projects/harness", path: "memory/pages/projects/harness.md" })
      )
    ).toBe("projects/harness");
  });

  it("recovers the slug from a memory index path when id is absent", () => {
    expect(
      pageSlug(page({ sourceType: "memory", path: "memory/pages/decisions/memory-index.md" }))
    ).toBe("decisions/memory-index");
  });

  it("passes non-memory index paths through unchanged for display", () => {
    // Tasks/runs/files are not memory pages; their indexed path is an identity
    // for display only and must never be used as a memory API key.
    expect(pageSlug(page({ sourceType: "task", path: "tasks/task-1" }))).toBe("tasks/task-1");
  });
});

describe("isMemoryPage", () => {
  it("is true for a default-list page with a slug", () => {
    expect(isMemoryPage(page({ slug: "projects/app/plan" }))).toBe(true);
  });

  it("is true for a memory index hit without a slug", () => {
    expect(
      isMemoryPage(
        page({ sourceType: "memory", id: "memory:projects/harness", path: "memory/pages/projects/harness.md" })
      )
    ).toBe(true);
  });

  it("is false for non-memory index rows", () => {
    expect(isMemoryPage(page({ sourceType: "task", path: "tasks/task-1" }))).toBe(false);
    expect(isMemoryPage(page({ sourceType: "run", path: "runs/run-1" }))).toBe(false);
    expect(isMemoryPage(page({ sourceType: "file", path: "src/app.ts" }))).toBe(false);
  });

  it("is false for a row with neither slug nor memory source type", () => {
    expect(isMemoryPage(page({}))).toBe(false);
  });
});

describe("withoutPage", () => {
  it("removes only the page whose slug matches and keeps the rest", () => {
    const pages = [
      page({ slug: "projects/app/plan" }),
      page({ slug: "projects/app/notes" }),
      page({ slug: "projects/other/plan" })
    ];
    const remaining = withoutPage(pages, "projects/app/plan");
    expect(remaining.map((p) => p.slug)).toEqual(["projects/app/notes", "projects/other/plan"]);
  });

  it("matches by path when the deleted page has no slug", () => {
    const pages = [
      page({ path: "projects/app/plan" }),
      page({ path: "projects/app/notes" })
    ];
    expect(withoutPage(pages, "projects/app/plan").map((p) => p.path)).toEqual([
      "projects/app/notes"
    ]);
  });

  it("leaves the list unchanged when the slug is not present", () => {
    const pages = [page({ slug: "projects/app/plan" }), page({ slug: "projects/app/notes" })];
    expect(withoutPage(pages, "projects/missing").map((p) => p.slug)).toEqual([
      "projects/app/plan",
      "projects/app/notes"
    ]);
  });

  it("does not mutate the input list", () => {
    const pages = [page({ slug: "projects/app/plan" })];
    withoutPage(pages, "projects/app/plan");
    expect(pages).toHaveLength(1);
  });
});
