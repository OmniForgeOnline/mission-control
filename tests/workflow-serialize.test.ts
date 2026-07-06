import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { validateWorkflow, type WorkflowDefinition } from "../src/core/workflows/index.ts";
import { serializeWorkflow } from "../src/core/workflows/serialize.ts";

const demoWorkflow: WorkflowDefinition = {
  id: "demo",
  name: "Demo",
  initial: "start",
  defaults: { author: "claude", reviewer: "codex", effort: "medium" },
  steps: {
    start: {
      id: "start",
      kind: "agent_turn",
      agent: "author",
      effort: "high",
      skill: "demo-skill",
      extensions: ["claude:plugin:demo@market"],
      approval: "required",
      next: "fan_out"
    },
    fan_out: {
      id: "fan_out",
      kind: "agent_turn",
      agent: "none",
      approval: "none",
      parallel: ["a", "b"]
    },
    a: {
      id: "a",
      kind: "agent_turn",
      agent: "none",
      approval: "none",
      join: "merge",
      joinPolicy: "all",
      branch: { failed: "start" }
    },
    b: { id: "b", kind: "agent_turn", agent: "none", approval: "none", join: "merge", branch: { failed: "start" } },
    merge: {
      id: "merge",
      kind: "agent_turn",
      agent: "reviewer",
      approval: "none",
      modifiesRepo: true,
      mergeRequestTitle: "T",
      mergeRequestDescription: "D",
      next: "end"
    },
    end: { id: "end", kind: "terminal", agent: "none", approval: "none" }
  }
};

describe("serializeWorkflow", () => {
  it("round-trips a workflow with every field type through YAML", () => {
    const text = serializeWorkflow(demoWorkflow);
    const reparsed = validateWorkflow(parseYaml(text));
    expect(reparsed).toEqual(demoWorkflow);
  });

  it("emits canonical key order with snake_case keys", () => {
    const text = serializeWorkflow(demoWorkflow);
    expect(text.indexOf("id: demo")).toBeLessThan(text.indexOf("name: Demo"));
    expect(text.indexOf("name: Demo")).toBeLessThan(text.indexOf("initial: start"));
    expect(text.indexOf("defaults:")).toBeLessThan(text.indexOf("steps:"));
    expect(text).toContain("modifies_repo: true");
    expect(text).toContain("merge_request_title: T");
    expect(text).toContain("merge_request_description: D");
    expect(text).toContain("join_policy: all");
    // camelCase keys must never leak into the YAML.
    expect(text).not.toContain("modifiesRepo");
    expect(text).not.toContain("joinPolicy");
    expect(text).not.toContain("mergeRequestTitle");
  });

  it("omits optional fields that are not set", () => {
    const minimal: WorkflowDefinition = {
      id: "mini",
      name: "Mini",
      initial: "only",
      defaults: { author: "claude", reviewer: "claude" },
      steps: {
        only: { id: "only", kind: "terminal", agent: "none", approval: "none" }
      }
    };
    const text = serializeWorkflow(minimal);
    expect(text).not.toContain("effort:");
    expect(text).not.toContain("skill:");
    expect(text).not.toContain("next:");
  });

  it("marks the file as harness-managed with a header comment", () => {
    const text = serializeWorkflow(demoWorkflow);
    expect(text.startsWith("#")).toBe(true);
    expect(text).toContain("Harness");
  });
});
