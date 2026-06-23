import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { describe, expect, it } from "vitest";

const fixturePath = (...parts: string[]) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", ...parts);

import { prepareTextForMarkdown, parseGrokStreamingOutput } from "../src/core/agents/output.ts";
import { repairStreamedTables } from "../src/core/infra/markdown-tables.ts";

marked.setOptions({ gfm: true, breaks: true });

describe("markdown table repair", () => {
  it("rebuilds mega-rows using the header column count", () => {
    const broken = [
      "| Module | What to test | Pattern |",
      "| --- |",
      "",
      "| fs.ts | readJson fallback | Temp fixtures | checks.ts | runChecks skipped | Mirror hooks.test.ts |"
    ].join("\n");

    const fixed = repairStreamedTables(broken);
    expect(fixed).toContain("| Module | What to test | Pattern |");
    expect(fixed).toContain("| fs.ts | readJson fallback | Temp fixtures |");
    expect(fixed).toContain("| checks.ts | runChecks skipped | Mirror hooks.test.ts |");

    const html = marked.parse(fixed) as string;
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Module</th>");
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("repairs the user's collapsed planning tables for rendering", () => {
    const userBroken = [
      "### Planning turn 1",
      "",
      "**Target modules with no direct test coverage today**",
      "| Module | What to test | Pattern |",
      "| --- |",
      "",
      "| fs.ts | readJsonFile fallback | Temp dir fixtures | checks.ts | runChecks skipped | Mirror hooks.test.ts YAML fixture style | activity.ts | ACTIVITY_THRESHOLDS exports sane values | Pure assertions | intake-prompts.ts | buildIntakePrompt includes workflow catalog | Minimal fixturesDependencies: None — new file only |",
      "",
      "Effort Summary",
      "| Step | Effort | ------ |",
      "| Add tests/core.test.ts | Medium (~80–120 lines) | Verify + optional quality.test.ts extension | Low | Push + handoff | LowTotal: ~1 implementation turn |"
    ].join("\n");

    const prepared = prepareTextForMarkdown(userBroken);
    const html = marked.parse(prepared) as string;

    expect(prepared).toContain("| fs.ts | readJsonFile fallback | Temp dir fixtures |");
    expect(prepared).toContain("| checks.ts | runChecks skipped |");
    expect(prepared).toContain("Dependencies: None");
    expect(html).toContain("<table>");
    expect((html.match(/<table>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("repairs tables with orphan dash fragments from stored task messages", () => {
    const storedSnippet = [
      "**Target modules with no direct test coverage today**",
      "",
      "| Module | What to test | Pattern |",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "",
      "| --- |",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "",
      "| `fs.ts` | `readJsonFile` fallback | Temp dir fixtures | `checks.ts` | `runChecks` skipped | Mirror `hooks.test.ts` | `activity.ts` | `ACTIVITY_THRESHOLDS` exports sane values | Pure assertions | `intake-prompts.ts` | `buildIntakePrompt` includes workflow catalog | Minimal fixtures**Dependencies:** None — new file only |"
    ].join("\n");

    const fixed = repairStreamedTables(storedSnippet);
    expect(fixed).not.toMatch(/\n-\n/);
    expect(fixed).toContain("| `fs.ts` | `readJsonFile` fallback | Temp dir fixtures |");
    expect(fixed).toContain("| `checks.ts` | `runChecks` skipped | Mirror `hooks.test.ts` |");
    expect(fixed).toContain("**Dependencies:** None");

    const html = marked.parse(fixed) as string;
    expect(html).toContain("<table>");
    expect(html).not.toContain("<td>-</td>");
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("repairs the live tasks.json planning message for rendering", () => {
    const tasksPath = "data/state/tasks.json";
    if (!existsSync(tasksPath)) {
      return;
    }
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    const task = tasks.find((entry: { id: string }) => entry.id === "2c4cd08b-70c8-4634-b494-4f04f9f5fdfa");
    if (!task?.messages?.length) {
      return;
    }
    const message = task.messages.find((entry: { author: string; body: string }) => entry.author === "agent" && entry.body.length > 1000);
    if (!message) {
      return;
    }

    const prepared = prepareTextForMarkdown(message.body);
    const html = marked.parse(prepared) as string;

    expect(prepared).toContain("| `fs.ts` |");
    expect(prepared).toContain("| `checks.ts` |");
    expect(prepared).not.toMatch(/\n-\n-\n/);
    expect((html.match(/<table>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("<td>-</td>");
  });

  it("keeps already-valid grok planning tables intact", () => {
    const raw = readFileSync(fixturePath("grok-quality-gate-planning-stream.txt"), "utf8");
    const prepared = prepareTextForMarkdown(
      `### Planning turn 1\n\n${parseGrokStreamingOutput(raw).reply}`
    );
    const html = marked.parse(prepared) as string;

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Module</th>");
    expect(html).toContain("<th>Step</th>");
    expect(html).toContain("<th>Risk</th>");
    expect((html.match(/<table>/g) ?? []).length).toBe(3);
  });
});