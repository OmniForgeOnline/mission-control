import { readFile } from "node:fs/promises";
import path from "node:path";

import { deriveLegacyStatus } from "../../core/tasks/status.ts";
import { listAllRuns } from "../../core/tasks/runs.ts";
import { getTask, listTasks } from "../../core/tasks/tasks.ts";
import { EntityNotFoundError } from "../../core/tasks/errors.ts";
import { DEFAULT_WORKFLOW_ID, loadWorkflow } from "../../core/workflows/index.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

export const taskTools: McpToolModule = {
  definitions: [
    {
      name: "list_runs",
      description: "List runs, optionally filtered by taskId. Returns id, taskId, agent, status, startedAt, completedAt.",
      inputSchema: { type: "object", properties: { taskId: { type: "string" }, limit: { type: "number" } } }
    },
    {
      name: "read_run",
      description: "Read an artifact from a run directory. file ∈ {prompt.md, log.txt, summary.md}.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" }, file: { type: "string" } },
        required: ["runId"]
      }
    },
    {
      name: "list_tasks",
      description: "List tasks, optionally filtered by status. Returns id, title, status, agent, turnCount.",
      inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" } } }
    },
    {
      name: "read_task",
      description: "Read a full task record (including messages).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  ],
  handlers: {
    list_runs: async (ctx, args) => {
      const taskId = typeof args["taskId"] === "string" ? args["taskId"] : undefined;
      const limit = Number(args["limit"] ?? 50);
      const runs = await listAllRuns(ctx.root);
      const filtered = taskId ? runs.filter((r) => r.taskId === taskId) : runs;
      return asText(
        filtered.slice(0, limit).map((r) => ({
          id: r.id,
          taskId: r.taskId,
          agent: r.agent,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          blockedReason: r.blockedReason
        }))
      );
    },
    read_run: async (ctx, args) => {
      const id = String(args["runId"]);
      const file = typeof args["file"] === "string" ? args["file"] : "summary.md";
      if (!/^(prompt\.md|log\.txt|summary\.md)$/.test(file)) {
        throw new Error("file must be one of prompt.md, log.txt, summary.md");
      }
      const fullPath = path.join(ctx.root, "data", "runs", id, file);
      const content = await readFile(fullPath, "utf8");
      return asText({ runId: id, file, content });
    },
    list_tasks: async (ctx, args) => {
      const status = typeof args["status"] === "string" ? args["status"] : undefined;
      const limit = Number(args["limit"] ?? 50);
      const tasks = await listTasks(ctx.root);
      const workflowCache = new Map<string, Awaited<ReturnType<typeof loadWorkflow>>>();
      const enriched = await Promise.all(
        tasks.map(async (task) => {
          const workflowId = task.workflowRun?.workflowId ?? DEFAULT_WORKFLOW_ID;
          let workflow = workflowCache.get(workflowId);
          if (!workflow) {
            workflow = await loadWorkflow(ctx.root, workflowId);
            workflowCache.set(workflowId, workflow);
          }
          return { task, status: deriveLegacyStatus(task, workflow) };
        })
      );
      const filtered = status ? enriched.filter((entry) => entry.status === status) : enriched;
      return asText(
        filtered.slice(0, limit).map(({ task, status: legacyStatus }) => ({
          id: task.id,
          title: task.title,
          status: legacyStatus,
          agent: task.agent,
          turnCount: task.turnCount,
          branch: task.branch,
          runId: task.runId
        }))
      );
    },
    read_task: async (ctx, args) => {
      const id = String(args["id"]);
      const task = await getTask(ctx.root, id);
      if (!task) throw new EntityNotFoundError("task", id);
      return asText(task);
    }
  }
};