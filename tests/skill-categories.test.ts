import { describe, expect, it } from "vitest";
import { groupSkillsByCategory, resolveSkillCategory } from "../src/core/catalog/skill-categories.ts";

describe("skill categories", () => {
  it("maps known skills into the four primary groups", () => {
    expect(resolveSkillCategory("harness-turn-loop").id).toBe("loop");
    expect(resolveSkillCategory("harness-memory").id).toBe("platform");
    expect(resolveSkillCategory("pr-driven-execution").id).toBe("engineering");
    expect(resolveSkillCategory("content-production").id).toBe("domain");
  });

  it("respects frontmatter category overrides", () => {
    expect(resolveSkillCategory("custom-skill", "domain").id).toBe("domain");
  });

  it("groups skills in category order", () => {
    const grouped = groupSkillsByCategory([
      { name: "content-production", category: "domain" },
      { name: "harness-turn-loop", category: "loop" },
      { name: "code-review", category: "engineering" }
    ]);

    expect(grouped.map((entry) => entry.category.id)).toEqual(["loop", "engineering", "domain"]);
    expect(grouped[0]?.skills.map((skill) => skill.name)).toEqual(["harness-turn-loop"]);
  });
});