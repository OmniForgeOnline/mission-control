import { runAutonomyAgentTurn, type RunAutonomyAgentOptions } from "./agent-run.ts";
import { STALE_GUIDANCE } from "./job-types.ts";

export const GUIDANCE_SWEEP_TASK_ID = "autonomy:harness-guidance-sweep";

export async function buildGuidanceSweepContext(root: string): Promise<string> {
  const { readOptionalFile } = await import("./handlers/shared.ts");
  const path = await import("node:path");

  const relativeFiles = ["kernel/memory-policy.md", "kernel/operating-principles.md", "kernel/workflow-policy.md", "README.md"];
  const sections: string[] = [];

  for (const relativeFile of relativeFiles) {
    const content = await readOptionalFile(path.join(root, relativeFile));
    if (!content) {
      sections.push(`## ${relativeFile}\n\n(missing)`);
      continue;
    }
    const excerpt = content.trim().slice(0, 2000);
    sections.push(`## ${relativeFile}\n\n${excerpt}${content.length > 2000 ? "\n\n…(truncated)" : ""}`);
  }

  return [
    "Known stale phrases to watch for (non-exhaustive):",
    ...STALE_GUIDANCE.map((phrase) => `- ${phrase}`),
    "",
    "Kernel and README excerpts:",
    "",
    ...sections
  ].join("\n");
}

export function buildGuidanceSweepPrompt(context: string): string {
  return `You are the harness guidance-sweep agent on a scheduled autonomy run.

Compare harness kernel docs and README against how the daemon, MCP tools, and UI actually behave today. Draft proposals when written guidance is stale, misleading, or contradicts the codebase.

## Mandate

1. Read the excerpts below, then verify with MCP: \`kernel_read\`, \`gbrain_search\`, \`read_skill\`, \`list_tasks\`, \`list_runs\`.
2. Inspect relevant \`src/\` code when guidance claims specific daemon or workflow behavior.
3. File harness fixes via \`propose_rule\`, \`propose_skill\`, or \`propose_hook\`. Do NOT edit \`kernel/\`, \`skills/\`, or \`hooks/\` directly.
4. Do NOT file duplicate \`propose_*\` tickets for a target that already has an active proposal ticket.
5. If guidance is current, say so — do not invent churn.

## Focus

- References to removed CLIs, ports, or external apps the harness no longer uses
- Workflow policy that no longer matches \`src/daemon/\` step advancement
- Memory/recall guidance that contradicts \`src/memory/\` or MCP search tools
- Operator instructions that agents cannot follow with current MCP surface

## Guidance excerpts

${context}

## Output

End with a short operator handoff listing what you checked and which \`propose_*\` tickets you filed (titles only). If nothing needs changing, say so explicitly.`;
}

const guidanceSweepSpec = {
  taskId: GUIDANCE_SWEEP_TASK_ID,
  taskTitle: "Harness guidance sweep",
  stateFileName: "guidance-sweep.json",
  skipSummary: "Guidance sweep skipped: already running.",
  completedSummary: (turnNumber: number, proposalsCreated: number) =>
    `Guidance sweep turn ${turnNumber} completed; filed ${proposalsCreated} proposal(s).`,
  blockedSummary: (reason: string) => `Guidance sweep blocked: ${reason}`,
  buildContext: buildGuidanceSweepContext,
  buildPrompt: buildGuidanceSweepPrompt
};

export interface GuidanceSweepResult {
  runId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
}

export async function runHarnessGuidanceSweep(
  root: string,
  options?: RunAutonomyAgentOptions
): Promise<GuidanceSweepResult> {
  return runAutonomyAgentTurn(root, guidanceSweepSpec, options);
}