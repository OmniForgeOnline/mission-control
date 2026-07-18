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
        qualityWeight: 99,
        enabled: true
      }),
      normalizeModelPool({
        id: "cursor-default",
        toolId: "cursor",
        displayName: "Cursor (default)",
        modelArgs: [],
        qualityWeight: 10,
        enabled: false
      }),
      normalizeModelPool({
        id: "cursor-zed",
        toolId: "cursor",
        displayName: "Zed",
        modelArgs: ["--model", "zed"],
        qualityWeight: 40,
        enabled: true
      })
    ];
    expect(sortPoolsForDisplay(pools).map((p) => p.id)).toEqual([
      "cursor-default",
      "cursor-auto",
      "cursor-zed"
    ]);
  });

  it("sorts enabled / higher-quality pools first for the card preview", () => {
    const pools = [
      normalizeModelPool({ id: "a", toolId: "cursor", displayName: "Zed", qualityWeight: 40, enabled: false }),
      normalizeModelPool({ id: "b", toolId: "cursor", displayName: "Beta", qualityWeight: 90, enabled: true }),
      normalizeModelPool({ id: "c", toolId: "cursor", displayName: "Alpha", qualityWeight: 90, enabled: true })
    ];
    expect(sortPoolsForDisplay(pools).map((p) => p.id)).toEqual(["c", "b", "a"]);
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
