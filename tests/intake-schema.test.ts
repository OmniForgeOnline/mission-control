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

  it("accepts fenced JSON on live turns", () => {
    const result = parseAndValidateIntakeReply(
      `\`\`\`json\n${JSON.stringify(intakePayload())}\n\`\`\``,
      WORKFLOWS
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.ticket.workflowId).toBe("bugfix");
    }
  });

  it("extracts the JSON object when the agent wraps it in prose", () => {
    const result = parseAndValidateIntakeReply(
      `Sure! Here is the classification:\n${JSON.stringify(intakePayload())}\nLet me know if you need anything else.`,
      WORKFLOWS
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.ticket.workflowId).toBe("bugfix");
    }
  });

  // Guard: tolerating wrapped/fenced JSON must not swallow replies that contain
  // no JSON object at all (the original error path stays intact for those).
  it("still rejects prose that contains no JSON object", () => {
    const result = parseAndValidateIntakeReply(
      "I think this needs more research before I can classify it.",
      WORKFLOWS
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("single JSON object");
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