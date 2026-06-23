import { describe, expect, it } from "vitest";

import {
  groupWorkflowsByCategory,
  resolveWorkflowCategory
} from "../src/core/catalog/workflow-categories.ts";

describe("workflow categories", () => {
  it("maps known workflows into their primary groups", () => {
    expect(resolveWorkflowCategory("code-feature").id).toBe("engineering");
    expect(resolveWorkflowCategory("bugfix").id).toBe("engineering");
    expect(resolveWorkflowCategory("data-analysis").id).toBe("data");
    expect(resolveWorkflowCategory("blog-post").id).toBe("content");
    expect(resolveWorkflowCategory("incident-response").id).toBe("ops");
  });

  it("falls back to other for unknown workflows", () => {
    expect(resolveWorkflowCategory("totally-made-up").id).toBe("other");
  });

  it("groups workflows in category order and drops empty groups", () => {
    const grouped = groupWorkflowsByCategory([
      { id: "incident-response" },
      { id: "code-feature" },
      { id: "data-analysis" },
      { id: "bugfix" }
    ]);

    expect(grouped.map((entry) => entry.category.id)).toEqual(["engineering", "data", "ops"]);
    expect(grouped[0]?.workflows.map((workflow) => workflow.id)).toEqual(["code-feature", "bugfix"]);
  });
});
