import { describe, expect, it } from "vitest";

import { shouldUseInteractiveRunner } from "../src/runners/interactive-mode.ts";

describe("shouldUseInteractiveRunner", () => {
  it("enables interactive for authoring and conversation steps", () => {
    expect(
      shouldUseInteractiveRunner({
        stepKind: "agent_turn",
        adapter: "claude",
        reviewer: false,
        checksRemediation: false
      })
    ).toBe(true);
    expect(
      shouldUseInteractiveRunner({
        stepKind: "conversation",
        adapter: "codex",
        reviewer: false,
        checksRemediation: false
      })
    ).toBe(true);
  });

  it("keeps headless for review, remediation, and ACP", () => {
    expect(
      shouldUseInteractiveRunner({
        stepKind: "review",
        adapter: "claude",
        reviewer: true,
        checksRemediation: false
      })
    ).toBe(false);
    expect(
      shouldUseInteractiveRunner({
        stepKind: "agent_turn",
        adapter: "claude",
        reviewer: false,
        checksRemediation: true
      })
    ).toBe(false);
    expect(
      shouldUseInteractiveRunner({
        stepKind: "agent_turn",
        adapter: "acp",
        reviewer: false,
        checksRemediation: false
      })
    ).toBe(false);
  });

  it("honors forceHeadless and env disable", () => {
    expect(
      shouldUseInteractiveRunner({
        stepKind: "agent_turn",
        adapter: "claude",
        reviewer: false,
        checksRemediation: false,
        forceHeadless: true
      })
    ).toBe(false);
    expect(
      shouldUseInteractiveRunner({
        stepKind: "agent_turn",
        adapter: "claude",
        reviewer: false,
        checksRemediation: false,
        env: { HARNESS_INTERACTIVE: "0" }
      })
    ).toBe(false);
  });
});
