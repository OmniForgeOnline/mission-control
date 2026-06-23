import { captureMemoryProposal } from "../../memory/capture.ts";
import { safeRootPath } from "../infra/fs.ts";
import {
  formatProposalDescription,
  isProposalTicket,
  parseProposalFields
} from "./ticket.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { createTask, listTasks } from "../tasks/tasks.ts";
import type { CreateProposalInput, HarnessProposal, HarnessTask, ProposalKind } from "../types.ts";


function proposalTargetKey(kind: ProposalKind, targetPath: string): string {
  return `${kind}:${targetPath.trim()}`;
}

export function findActiveProposalTask(
  tasks: HarnessTask[],
  input: Pick<CreateProposalInput, "kind" | "targetPath">
): HarnessTask | undefined {
  const key = proposalTargetKey(input.kind, input.targetPath);
  return tasks.find((task) => {
    if (!isProposalTicket(task)) return false;
    if (task.resolution === "cancelled" || task.resolution === "completed") return false;
    if (task.resolution) return false;
    const fields = parseProposalFields(task);
    return proposalTargetKey(fields.kind, fields.targetPath) === key;
  });
}

function proposalStatus(task: HarnessTask): HarnessProposal["status"] {
  if (task.resolution === "cancelled") return "rejected";
  if (task.resolution === "completed") return "approved";
  return "pending";
}

export function proposalTaskToRecord(task: HarnessTask): HarnessProposal {
  const fields = parseProposalFields(task);
  return {
    id: task.id,
    kind: fields.kind,
    title: task.title,
    rationale: fields.rationale,
    targetPath: fields.targetPath,
    content: fields.content,
    status: proposalStatus(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { reviewedAt: task.completedAt } : {})
  };
}

export async function listProposalTasks(root: string): Promise<HarnessTask[]> {
  await ensureHarnessRepository(root);
  return (await listTasks(root)).filter(isProposalTicket);
}

export async function listProposals(root: string): Promise<HarnessProposal[]> {
  return (await listProposalTasks(root)).map(proposalTaskToRecord);
}

/** File a harness change ticket — identical to operator-created tasks (`source: manual`). */
export async function createProposal(root: string, input: CreateProposalInput): Promise<HarnessProposal> {
  const targetPath = input.targetPath.trim();
  safeRootPath(root, targetPath);

  if (input.kind === "memory") {
    if (!input.projectId) {
      throw new Error("Memory proposals require a projectId.");
    }
    return captureMemoryProposal(root, input.projectId, input);
  }

  const tasks = await listTasks(root);
  const existing = findActiveProposalTask(tasks, { kind: input.kind, targetPath });
  if (existing) {
    return proposalTaskToRecord(existing);
  }

  const task = await createTask(root, {
    title: input.title.trim(),
    description: formatProposalDescription(input),
    source: "manual",
    links: [],
    targets: [{ raw: targetPath, path: targetPath, kind: "file" }],
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {})
  });
  return proposalTaskToRecord(task);
}