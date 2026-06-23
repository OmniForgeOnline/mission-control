import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { normalizeModelPool, normalizeTool } from "../src/core/agents/config/normalize.ts";
import { resolveAgentLaunchPlan } from "../src/core/agents/runtime/launch.ts";
import { checkPromptBudget, deliverPrompt, promptTransportForLaunch } from "../src/core/agents/runtime/prompt-transport.ts";
import { probeAgentRuntime } from "../src/core/agents/runtime/probe.ts";

describe("agent runtime launch planning", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-agent-runtime-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the exact command path and prepends its directory to child PATH", async () => {
    const bin = path.join(root, "fake-agent");
    await writeFile(bin, "#!/bin/sh\necho fake-agent 1.0\n", "utf8");
    await chmod(bin, 0o755);
    const tool = normalizeTool({ id: "fake", command: bin, adapter: "generic" });
    const pool = normalizeModelPool({ id: "fake-default", toolId: "fake" });

    const plan = await resolveAgentLaunchPlan(tool, pool, { cwd: root, args: ["run"], env: { EXTRA: "1" } });

    expect(plan.available).toBe(true);
    expect(plan.command).toBe(bin);
    expect(plan.env["EXTRA"]).toBe("1");
    expect((plan.env["PATH"] ?? "").split(path.delimiter)[0]).toBe(root);
  });

  it("returns a structured diagnostic for a missing command", async () => {
    const tool = normalizeTool({ id: "missing", command: "definitely-not-on-path-harness-agent", adapter: "generic" });
    const pool = normalizeModelPool({ id: "missing-default", toolId: "missing" });

    const plan = await resolveAgentLaunchPlan(tool, pool, { cwd: root, args: [], env: {} });

    expect(plan.available).toBe(false);
    expect(plan.diagnostics[0]?.code).toBe("AGENT_COMMAND_NOT_FOUND");
  });
});

describe("agent runtime prompt transport", () => {
  it("blocks oversized argv prompts before spawn", () => {
    const tool = normalizeTool({
      id: "argv",
      command: "argv",
      adapter: "generic",
      promptTransport: "argv",
      maxPromptArgBytes: 4
    });
    const error = checkPromptBudget(tool, "hello");
    expect(error?.code).toBe("AGENT_PROMPT_TOO_LARGE");
  });

  it("delivers text prompts over stdin and closes it", () => {
    const writes: string[] = [];
    let ended = false;
    deliverPrompt(
      { write: (value: string) => { writes.push(value); return true; }, end: (value?: string) => { if (value) writes.push(value); ended = true; return undefined as never; } },
      { transport: "stdin", inputFormat: "text" },
      "hello"
    );
    expect(writes).toEqual(["hello"]);
    expect(ended).toBe(true);
  });

  it("delivers stream-json prompts without closing stdin", () => {
    const writes: string[] = [];
    let ended = false;
    deliverPrompt(
      { write: (value: string) => { writes.push(value); return true; }, end: () => { ended = true; return undefined as never; } },
      { transport: "stdin", inputFormat: "stream-json", keepOpen: true },
      "hello"
    );
    expect(JSON.parse(writes[0]!).message.content[0].text).toBe("hello");
    expect(ended).toBe(false);
  });

  it("derives transport metadata from launch config", () => {
    const tool = normalizeTool({ id: "codex", command: "codex", adapter: "codex", promptTransport: "stdin" });
    const transport = promptTransportForLaunch(tool, { promptOnStdin: true });
    expect(transport).toEqual({ transport: "stdin", inputFormat: "text" });
  });
});

describe("agent runtime probe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-agent-probe-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the launch command for version and help capability probes", async () => {
    const bin = path.join(root, "fake-probe-agent");
    await writeFile(
      bin,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake 2.0; exit 0; fi\nif [ \"$1\" = \"--help\" ]; then echo '--flag-a --flag-b'; exit 0; fi\nexit 0\n",
      "utf8"
    );
    await chmod(bin, 0o755);
    const tool = normalizeTool({
      id: "fake",
      command: bin,
      adapter: "generic",
      versionArgs: ["--version"],
      helpArgs: ["--help"],
      capabilityFlags: { "--flag-a": "flagA", "--missing": "missing" }
    });

    const result = await probeAgentRuntime(tool, { cwd: root });

    expect(result.available).toBe(true);
    expect(result.command).toBe(bin);
    expect(result.version).toBe("fake 2.0");
    expect(result.capabilities).toEqual({ flagA: true, missing: false });
  });
});
