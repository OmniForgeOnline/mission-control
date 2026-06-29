import { describe, expect, it } from "vitest";

import { updatePillModel, type VersionStatus } from "../src/ui/shell/update-pill.ts";

function status(overrides: Partial<VersionStatus> = {}): VersionStatus {
  return {
    installed: "0.1.3",
    latest: "0.1.4",
    behind: true,
    fetchedAt: "2026-06-29T00:00:00.000Z",
    canSelfUpdate: true,
    lastUpdate: null,
    ...overrides
  };
}

describe("updatePillModel", () => {
  it("is hidden when there is no status yet", () => {
    expect(updatePillModel(null).visible).toBe(false);
  });

  it("is hidden when the install is current", () => {
    expect(updatePillModel(status({ behind: false })).visible).toBe(false);
  });

  it("is visible when behind and exposes the target version", () => {
    const model = updatePillModel(status({ behind: true, latest: "0.1.4" }));
    expect(model.visible).toBe(true);
    expect(model.latest).toBe("0.1.4");
    expect(model.canSelfUpdate).toBe(true);
  });
});
