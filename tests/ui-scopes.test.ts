import { describe, expect, it } from "vitest";

import {
  includesTaskActivityScope,
  includesTaskScope,
  unionScopes
} from "../src/ui/app/scopes.ts";

describe("ui scopes", () => {
  it("treats activity scopes separately from full task scopes", () => {
    expect(includesTaskActivityScope(["task:abc:activity"], "abc")).toBe(true);
    expect(includesTaskScope(["task:abc:activity"], "abc")).toBe(false);
    expect(includesTaskScope(["task:abc"], "abc")).toBe(true);
  });

  it("unionScopes collapses to all when present", () => {
    expect(unionScopes(["chrome"], ["all"])).toEqual(["all"]);
    expect(unionScopes(["task:1:activity"], ["task:1:messages"])).toEqual([
      "task:1:activity",
      "task:1:messages"
    ]);
  });
});