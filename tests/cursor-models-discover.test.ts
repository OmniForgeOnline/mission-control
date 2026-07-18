import { describe, expect, it } from "vitest";

import {
  cursorPoolIdForModel,
  mapCursorModels
} from "../src/core/agents/config/models-discover-cursor.ts";

describe("cursor model discovery", () => {
  it("parses cursor-agent --list-models text", () => {
    const stdout = `Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
claude-opus-4-8-high - Opus 4.8 1M
claude-fable-5-high - Fable 5 1M (NO ZDR)
not-a-model-line
`;
    expect(mapCursorModels(stdout)).toEqual([
      { id: "auto", displayName: "Auto" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "claude-opus-4-8-high", displayName: "Opus 4.8 1M" },
      { id: "claude-fable-5-high", displayName: "Fable 5 1M" }
    ]);
  });

  it("dedupes repeated model ids", () => {
    expect(
      mapCursorModels(`auto - Auto
auto - Auto again`)
    ).toEqual([{ id: "auto", displayName: "Auto" }]);
  });

  it("builds cursor-prefixed pool ids", () => {
    expect(cursorPoolIdForModel("composer-2.5")).toBe("cursor-composer-2.5");
  });
});
