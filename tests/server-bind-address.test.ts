import { describe, expect, it } from "vitest";

import { resolveListenHost } from "../src/server/bind-address.ts";

describe("resolveListenHost", () => {
  it("defaults to loopback so native runs are not network-exposed", () => {
    expect(resolveListenHost({})).toBe("127.0.0.1");
    expect(resolveListenHost({ HARNESS_HOST: "" })).toBe("127.0.0.1");
    expect(resolveListenHost({ HARNESS_HOST: "   " })).toBe("127.0.0.1");
  });

  it("honors HARNESS_HOST for explicit network binding", () => {
    expect(resolveListenHost({ HARNESS_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});
