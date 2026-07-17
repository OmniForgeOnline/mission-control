import { describe, expect, it } from "vitest";

import { parseClientMessage } from "../src/terminal/protocol.ts";

describe("terminal client message parser", () => {
  it("parses input, resize, and ping", () => {
    expect(parseClientMessage(JSON.stringify({ type: "input", data: "a" }))).toEqual({
      type: "input",
      data: "a"
    });
    expect(parseClientMessage(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))).toEqual({
      type: "resize",
      cols: 100,
      rows: 40
    });
    expect(parseClientMessage(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
  });

  it("rejects malformed payloads", () => {
    expect(parseClientMessage("not-json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "input" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "resize", cols: 0, rows: 10 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});
