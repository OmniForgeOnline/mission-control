import { parseAndValidateIntakeReply, validateIntakeAgentOutput } from "../src/core/intake/schema.ts";

const WORKFLOWS = new Set(["bugfix", "code-feature", "write-document"]);

function intakePayload(ticketOverrides: Record<string, unknown> = {}) {
  return {
    reply: "Looks like a bugfix.",
    ticket: {
      ready: true,
      title: "Fix API 500",
      description: "Patch empty payload handling.",
      workflowId: "bugfix",
      confidence: "high",
      rationale: "Clear defect.",
      suggestNewWorkflow: null,
      ...ticketOverrides
    }
  };
}

describe("intake schema validation", () => {
  it("accepts programmatic raw JSON output", () => {
    const result = parseAndValidateIntakeReply(JSON.stringify(intakePayload()), WORKFLOWS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.ticket.ready).toBe(true);
      expect(result.output.ticket.workflowId).toBe("bugfix");
    }
  });

  it("rejects markdown code fences on live turns", () => {
    const result = parseAndValidateIntakeReply(
      `\`\`\`json\n${JSON.stringify(intakePayload())}\n\`\`\``,
      WORKFLOWS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("code fences");
    }
  });

  it("rejects ready tickets with unknown workflow ids", () => {
    const result = validateIntakeAgentOutput(
      intakePayload({ workflowId: "legal-review" }),
      WORKFLOWS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("not a bundled workflow");
    }
  });

  it("rejects ready tickets with empty title", () => {
    const result = validateIntakeAgentOutput(intakePayload({ title: "" }), WORKFLOWS);
    expect(result.ok).toBe(false);
  });

  it("rejects not-ready tickets that still include a workflow id", () => {
    const result = validateIntakeAgentOutput(
      intakePayload({ ready: false, title: "", description: "", workflowId: "bugfix" }),
      WORKFLOWS
    );
    expect(result.ok).toBe(false);
  });
});