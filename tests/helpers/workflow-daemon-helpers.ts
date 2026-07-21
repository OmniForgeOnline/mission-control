import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../../src/runners/types.ts";
import { ensureHarnessRepository } from "../../src/core/bootstrap/repository.ts";
import { getTask } from "../../src/core/tasks/tasks.ts";

export const execFileAsync = promisify(execFile);

export class BlockingRunner implements AgentRunner {
  agent = "claude" as const;

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    request.onOutput?.(`started ${request.task.id}\n`);
    await new Promise(() => {});
    throw new Error("unreachable");
  }

  abort(): void {
    /* no-op */
  }
}

export async function waitForTask(
  root: string,
  taskId: string,
  predicate: (task: NonNullable<Awaited<ReturnType<typeof getTask>>>) => boolean,
  timeoutMs = 3000
): Promise<Awaited<ReturnType<typeof getTask>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(root, taskId);
    if (task && predicate(task)) return task;
    if (Date.now() >= deadline) return task;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function createWorkflowDaemonRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-wf-daemon-"));
  await ensureHarnessRepository(root);
  return root;
}
