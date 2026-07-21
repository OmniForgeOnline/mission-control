import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { tolerateMissingRun } from "../src/daemon/turn-completion.ts";

describe("turn-completion run-log writes", () => {
  it("swallows ENOENT when the run dir is gone mid-turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-turn-log-"));
    try {
      const gone = path.join(root, "runs", "no-such-run", "log.txt");
      await expect(tolerateMissingRun(appendFile(gone, "late chunk", "utf8"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still surfaces non-ENOENT errors", async () => {
    await expect(tolerateMissingRun(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
