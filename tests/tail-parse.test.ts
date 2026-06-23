import { describe, expect, it } from "vitest";

import { coalesceStreamEvents, toRows } from "../src/ui/features/runs/tail/parse.ts";

describe("run tail parser", () => {
  it("hides thinking token bookkeeping items from item-based agents", () => {
    expect(
      toRows(
        {
          type: "item.completed",
          item: { id: "item_1", type: "thinking_tokens", tokens: 128 }
        },
        0
      )
    ).toEqual([]);
    expect(
      toRows(
        {
          type: "item.started",
          item: { id: "item_2", type: "token_count", input_tokens: 10, output_tokens: 20 }
        },
        1
      )
    ).toEqual([]);
  });

  it("hides generic token bookkeeping events", () => {
    expect(toRows({ type: "token_count", total: 128 }, 0)).toEqual([]);
    expect(toRows({ type: "usage", input_tokens: 10, output_tokens: 20 }, 1)).toEqual([]);
  });

  it("hides non-actionable system bookkeeping but keeps useful system events", () => {
    expect(toRows({ type: "system", subtype: "thinking_tokens", tokens: 128 }, 0)).toEqual([]);

    const initRows = toRows({ type: "system", subtype: "init", model: "sonnet", cwd: "/repo" }, 1);
    expect(initRows).toHaveLength(1);
    expect(initRows[0]?.title).toContain("session started");
  });

  it("coalesces grok thought chunks while keeping real thinking text visible", () => {
    const rows = coalesceStreamEvents([
      { type: "thought", data: "checking " },
      { type: "thought", data: "files" },
      { type: "text", data: "done" }
    ]).flatMap(toRows);

    expect(rows.map((row) => [row.kind, row.title])).toEqual([
      ["thinking", "checking files"],
      ["assistant", "message"]
    ]);
  });

  it("keeps actionable codex command items visible", () => {
    const rows = toRows(
      {
        type: "item.started",
        item: { id: "item_2", type: "command_execution", command: "npm run test" }
      },
      0
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool");
    expect(rows[0]?.title).toBe("running tests");
  });
});
