import type { CreateProposalInput, HarnessTask, ProposalKind } from "../types.ts";

export const PROPOSAL_SECTION_MARKER = "## Proposal";

export function formatProposalDescription(input: CreateProposalInput): string {
  return `${input.rationale.trim()}

${PROPOSAL_SECTION_MARKER}

- **Kind:** ${input.kind}
- **Target:** \`${input.targetPath.trim()}\`

### Proposed change

${input.content.trim()}`;
}

/** @deprecated Legacy tickets only; new propose_* calls create normal tasks. */
function isProposalTask(task: HarnessTask): boolean {
  return task.label === "proposal" || Boolean(task.proposalChange);
}

/** Tickets filed via propose_* (legacy label or standard description marker). */
export function isProposalTicket(task: HarnessTask): boolean {
  if (isProposalTask(task)) return true;
  return task.description?.includes(PROPOSAL_SECTION_MARKER) ?? false;
}

/** Convert legacy proposal sidecars into operator-equivalent tickets. */
export function normalizeLegacyProposalTicket(task: HarnessTask): { task: HarnessTask; changed: boolean } {
  const legacySidecar = Boolean(task.proposalChange) || task.label === "proposal";
  const wrongSource = task.source !== "manual" && isProposalTicket(task);
  if (!legacySidecar && !wrongSource) {
    return { task, changed: false };
  }

  const change = task.proposalChange;
  const targetPath = change?.targetPath?.trim() ?? task.targets?.[0]?.path ?? "";
  const hasMarker = task.description?.includes(PROPOSAL_SECTION_MARKER) ?? false;

  let description = task.description;
  if (change && !hasMarker) {
    description = formatProposalDescription({
      kind: change.kind,
      title: task.title,
      rationale: task.description.trim() || task.title,
      targetPath,
      content: change.content
    });
  }

  const targets =
    task.targets?.length || !targetPath
      ? task.targets
      : [{ raw: targetPath, path: targetPath, kind: "file" as const }];

  const { label: _label, proposalChange: _change, ...rest } = task;
  const normalized: HarnessTask = {
    ...rest,
    source: "manual",
    description,
    targets: targets ?? []
  };

  const changed =
    task.source !== normalized.source ||
    task.description !== normalized.description ||
    task.label !== undefined ||
    task.proposalChange !== undefined ||
    JSON.stringify(task.targets ?? []) !== JSON.stringify(normalized.targets);

  return { task: normalized, changed };
}

export function parseProposalFields(task: HarnessTask): {
  kind: ProposalKind;
  targetPath: string;
  content: string;
  rationale: string;
} {
  if (task.proposalChange) {
    const markerIndex = task.description.indexOf(PROPOSAL_SECTION_MARKER);
    const rationale =
      markerIndex === -1
        ? task.description
        : task.description.slice(0, markerIndex).trim();
    return {
      kind: task.proposalChange.kind,
      targetPath: task.proposalChange.targetPath,
      content: task.proposalChange.content,
      rationale
    };
  }

  const markerIndex = task.description.indexOf(PROPOSAL_SECTION_MARKER);
  const rationale = markerIndex === -1 ? task.description : task.description.slice(0, markerIndex).trim();
  const body = markerIndex === -1 ? task.description : task.description.slice(markerIndex);
  const kind = (body.match(/- \*\*Kind:\*\* (\w+)/)?.[1] ?? "memory") as ProposalKind;
  const targetPath =
    body.match(/- \*\*Target:\*\* `([^`]+)`/)?.[1] ?? task.targets?.[0]?.path ?? "";
  const content = body.split("### Proposed change\n")[1]?.trim() ?? "";
  return { kind, targetPath, content, rationale };
}