import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import {
  DEFAULT_QUICKSTARTS,
  generateProjectQuickstarts,
  parseAndValidateQuickstarts,
  readProjectQuickstarts,
  type QuickStart
} from "../src/core/projects/quickstarts.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

function slotCount(prompt: string): number {
  return (prompt.match(/\[[^\]]+\]/g) ?? []).length;
}

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

const VALID_FOUR: QuickStart[] = [
  { label: "Fix a parser bug", prompt: "Investigate a bug in [area]. Symptom: [what happens]." },
  { label: "Add an endpoint", prompt: "Add a [METHOD] [route] endpoint that [behavior]." },
  { label: "Cover the runner", prompt: "Add test coverage for [module]: [cases]." },
  { label: "Refactor storage", prompt: "Refactor [module] to [goal] without changing behavior." }
];

describe("quickstarts defaults", () => {
  it("ships 3-6 rich default templates, each with a non-empty prompt and at least one [slot]", () => {
    expect(DEFAULT_QUICKSTARTS.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_QUICKSTARTS.length).toBeLessThanOrEqual(6);
    for (const item of DEFAULT_QUICKSTARTS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.prompt.trim().length).toBeGreaterThan(0);
      expect(slotCount(item.prompt)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("parseAndValidateQuickstarts", () => {
  it("accepts a bare JSON array of 3 items", () => {
    const result = parseAndValidateQuickstarts(JSON.stringify(VALID_FOUR.slice(0, 3)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quickstarts).toHaveLength(3);
  });

  it("accepts a { quickstarts: [...] } envelope", () => {
    const result = parseAndValidateQuickstarts(JSON.stringify({ quickstarts: VALID_FOUR }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quickstarts).toHaveLength(4);
  });

  it("accepts output wrapped in a ```json fence", () => {
    const fenced = "```json\n" + JSON.stringify(VALID_FOUR) + "\n```";
    const result = parseAndValidateQuickstarts(fenced);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quickstarts).toHaveLength(4);
  });

  it("clamps more than 6 items down to 6 (truncate)", () => {
    const many = Array.from({ length: 9 }, (_unused, i) => ({
      label: `Task ${i}`,
      prompt: `Do [thing ${i}] in [area].`
    }));
    const result = parseAndValidateQuickstarts(JSON.stringify(many));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quickstarts).toHaveLength(6);
      expect(result.quickstarts[0]!.label).toBe("Task 0");
      expect(result.quickstarts[5]!.label).toBe("Task 5");
    }
  });

  it("rejects fewer than 3 valid items", () => {
    const result = parseAndValidateQuickstarts(JSON.stringify(VALID_FOUR.slice(0, 2)));
    expect(result.ok).toBe(false);
  });

  it("rejects items missing label or prompt", () => {
    const bad = [
      { label: "ok", prompt: "do [x]" },
      { label: "", prompt: "missing label [y]" },
      { label: "no prompt", prompt: "" }
    ];
    const result = parseAndValidateQuickstarts(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it("rejects non-JSON output", () => {
    const result = parseAndValidateQuickstarts("here are some ideas for you to consider");
    expect(result.ok).toBe(false);
  });
});

describe("project quickstarts storage + generation", () => {
  let tmp: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "harness-quickstarts-"));
    execSync("git init", { cwd: tmp });
    execSync("git config user.email t@t.com", { cwd: tmp });
    execSync("git config user.name t", { cwd: tmp });
    execSync("git init my-app", { cwd: tmp });
    project = await onboardProject(tmp, { repoPath: path.join(tmp, "my-app"), name: "My App" });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("returns the defaults with status 'default' when nothing is generated yet", async () => {
    const file = await readProjectQuickstarts(tmp, project.id);
    expect(file.status).toBe("default");
    expect(file.quickstarts).toEqual(DEFAULT_QUICKSTARTS);
  });

  it("writes a 'ready' file with the parsed items when the agent returns valid output", async () => {
    const runner = repliesRunner(JSON.stringify(VALID_FOUR));
    await generateProjectQuickstarts(tmp, project, { runner });

    const file = await readProjectQuickstarts(tmp, project.id);
    expect(file.status).toBe("ready");
    expect(file.quickstarts).toHaveLength(4);
    expect(file.quickstarts[0]!.label).toBe("Fix a parser bug");
    expect(file.repoPath).toBe(project.repoPath);
    expect(file.generatedAt).toBeTruthy();
  });

  it("marks the file 'failed' and falls back to defaults when the agent never returns valid output", async () => {
    const runner = repliesRunner("sorry, I cannot do that");
    await generateProjectQuickstarts(tmp, project, { runner });

    const file = await readProjectQuickstarts(tmp, project.id);
    expect(file.status).toBe("failed");
    expect(file.quickstarts).toEqual(DEFAULT_QUICKSTARTS);
    expect(file.error).toBeTruthy();
  });
});
