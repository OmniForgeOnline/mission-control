import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeModelPool } from "../src/core/agents/config/normalize.ts";
import {
  INLINE_MODEL_PREVIEW,
  sortPoolsForDisplay
} from "../src/ui/features/settings/agents/model-list.ts";

describe("settings models modal", () => {
  it("pins the no-arg default pool above other models", () => {
    const pools = [
      normalizeModelPool({
        id: "cursor-auto",
        toolId: "cursor",
        displayName: "Auto",
        modelArgs: ["--model", "auto"],
        enabled: true
      }),
      normalizeModelPool({
        id: "cursor-default",
        toolId: "cursor",
        displayName: "Cursor (default)",
        modelArgs: [],
        enabled: false
      }),
      normalizeModelPool({
        id: "cursor-zed",
        toolId: "cursor",
        displayName: "Zed",
        modelArgs: ["--model", "zed"],
        enabled: true
      })
    ];
    expect(sortPoolsForDisplay(pools).map((p) => p.id)).toEqual([
      "cursor-default",
      "cursor-auto",
      "cursor-zed"
    ]);
  });

  it("caps the inline preview and wires a models modal", () => {
    expect(INLINE_MODEL_PREVIEW).toBe(5);
    const section = readFileSync(
      path.join(process.cwd(), "src/ui/features/settings/agents/config-section.tsx"),
      "utf8"
    );
    const modal = readFileSync(
      path.join(process.cwd(), "src/ui/features/settings/agents/models-modal.tsx"),
      "utf8"
    );
    expect(section).toContain("INLINE_MODEL_PREVIEW");
    expect(section).toContain("ModelsModal");
    expect(section).toContain("view all");
    expect(modal).toContain("Discover models");
    expect(modal).toContain("Disable all");
    expect(modal).toContain("Enable all");
    expect(modal).toContain("bulk-enabled");
    expect(modal).toContain("AddModelForm");
  });
});
