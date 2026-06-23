import { buildFollowupCapturePrompt, gatherFollowupCandidates } from "../src/core/review/followup-capture.ts";
import type { HarnessTask } from "../src/core/types.ts";

function taskWithMessages(messages: HarnessTask["messages"]): HarnessTask {
  return {
    id: "9b4de099-a5ff-40e0-9410-86cca1902b7e",
    title: "Reduce bundle size",
    description: "## Goal\nTrim frontend bundle.",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages,
    approvedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("followup capture", () => {
  it("extracts handoff watch/open candidates", () => {
    const candidates = gatherFollowupCandidates(
      taskWithMessages([
        {
          id: "m1",
          author: "agent",
          body: "**Pushed.** harness/abc · 1 commit(s) · trim deps.\n\n**Open.** Add visual regression suite.\n\n**Watch.** Tree-shaking may miss dynamic imports.",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ])
    );

    expect(candidates.some((candidate) => candidate.source === "handoff-open")).toBe(true);
    expect(candidates.some((candidate) => candidate.detail.includes("dynamic imports"))).toBe(true);
  });

  it("builds capture prompt with extracted candidates", () => {
    const prompt = buildFollowupCapturePrompt(
      taskWithMessages([
        {
          id: "m1",
          author: "agent",
          body: "**Watch.** Provider auth still stubbed in tests.",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ])
    );

    expect(prompt).toContain("capture_followups");
    expect(prompt).toContain("Extracted candidates");
    expect(prompt).toContain("Provider auth still stubbed");
    expect(prompt).toContain("tech_debt_capture");
  });
});