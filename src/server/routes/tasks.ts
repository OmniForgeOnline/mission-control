import { Router } from "express";

import {
  processNextApprovedTask,
  resumeTask,
  runOperatorFollowupTurn,
  runTaskTurn
} from "../../daemon/processor.ts";
import { bindTaskRepoTarget } from "../../core/tasks/repo-binding.ts";
import {
  addTaskMessage,
  approvePlanForImplementation,
  approveTask,
  preparePlanRefinementTurn,
  cancelTask,
  createTask,
  deleteTask,
  deleteTasks,
  getTask,
  requeueTask,
  clearTaskStageAgentOverride,
  clearTaskStageEffortOverride,
  setPmStatusOverride,
  setTaskStageAgentOverride,
  setTaskStageEffortOverride,
  updateTask,
  updateTaskFields
} from "../../core/tasks/tasks.ts";
import { revertTaskToWorkflowStep } from "../../core/tasks/workflow-revert.ts";
import { launchEditorForTask } from "../../core/editors/launch.ts";
import { isEditorId } from "../../core/editors/registry.ts";
import { withAttachmentReferences } from "../../core/attachments/store.ts";
import {
  applyWorkflowNodeAction,
  nodeActionAllowed,
  type WorkflowNodeAction
} from "../../core/workflows/node-actions.ts";
import { isAwaitingOperator, isTaskRunning } from "../../core/tasks/status.ts";
import { loadWorkflow } from "../../core/workflows/index.ts";
import { isRegisteredAgent, unregisteredAgentMessage } from "../../core/agents/stage-agents.ts";
import { abortInflightTurn, deliverOperatorMessageToLiveTurn, listInflightTaskIds } from "../../runtime/sessions.ts";
import type { ToolId, CreateTaskInput, HarnessTask, PmStatus } from "../../core/types.ts";
import { isEffortLevel } from "../../core/types.ts";
import { asyncRoute, asStringArray, param, turnOptions, type ServerOptions } from "./helpers.ts";

export function createTasksRouter(options: ServerOptions): Router {
  const router = Router();
  const runTurnOptions = turnOptions(options);

  router.post(
    "/tasks",
    asyncRoute(async (req, res) => {
      const body = req.body as CreateTaskInput;
      const attachmentIds = asStringArray(body.attachmentIds);
      const task = await createTask(options.root, {
        ...body,
        ...(attachmentIds ? { attachmentIds } : {})
      });
      res.status(201).json(task);
    })
  );

  router.post(
    "/tasks/delete",
    asyncRoute(async (req, res) => {
      const body = req.body as { ids?: string[] };
      res.json(await deleteTasks(options.root, Array.isArray(body.ids) ? body.ids : []));
    })
  );

  router.post(
    "/tasks/:id/approve",
    asyncRoute(async (req, res) => {
      res.json(await approveTask(options.root, param(req.params["id"], "id")));
    })
  );

  router.post(
    "/tasks/:id/approve-plan",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const task = await approvePlanForImplementation(options.root, id);
      const turn = await runTaskTurn(options.root, id, runTurnOptions);
      if (!turn) {
        res.status(409).json({ error: "Task could not start the implement turn.", task });
        return;
      }
      res.json({ task: (await getTask(options.root, id)) ?? task, turn });
    })
  );

  router.post(
    "/tasks/:id/cancel",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const task = await getTask(options.root, id);
      if (!task) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      abortInflightTurn(id);
      res.json(await cancelTask(options.root, id));
    })
  );

  router.post(
    "/tasks/:id/requeue",
    asyncRoute(async (req, res) => {
      res.json(await requeueTask(options.root, param(req.params["id"], "id")));
    })
  );

  router.post(
    "/tasks/:id/bind-repo",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const body = req.body as { path?: string };
      const repoPath = body.path?.trim();
      if (!repoPath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      const current = await getTask(options.root, id);
      if (!current) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      if (isTaskRunning(current, listInflightTaskIds())) {
        res.status(409).json({ error: "Cannot change project while the task is running. Stop it first." });
        return;
      }

      const task = await bindTaskRepoTarget(options.root, id, repoPath);

      res.json({
        task: (await getTask(options.root, id)) ?? task,
        suggestedPath: options.root
      });
    })
  );

  router.post(
    "/tasks/:id/resume",
    asyncRoute(async (req, res) => {
      const result = await resumeTask(options.root, param(req.params["id"], "id"), runTurnOptions);
      if (!result) {
        res.status(409).json({ error: "Task cannot be resumed (wrong status or attempt cap exceeded)." });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    "/tasks/:id/open-in-editor",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const editorId = (req.body as { editor?: string }).editor?.trim();
      if (!editorId || !isEditorId(editorId)) {
        res.status(400).json({ error: "editor is required (vscode, cursor, codex, or kiro)." });
        return;
      }
      const task = await getTask(options.root, id);
      if (!task) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      try {
        const result = await launchEditorForTask({
          root: options.root,
          task,
          editorId,
          ...(options.editorSpawner ? { spawn: options.editorSpawner } : {})
        });
        res.json({ ok: true, editor: result.editorId, worktreePath: result.worktreePath });
      } catch (error) {
        res.status(409).json({ error: (error as Error).message });
      }
    })
  );

  router.patch(
    "/tasks/:id",
    asyncRoute(async (req, res) => {
      const updates = req.body as Partial<
        Pick<HarnessTask, "title" | "description" | "agent" | "effort" | "statusOverride">
      >;
      res.json(await updateTaskFields(options.root, param(req.params["id"], "id"), updates));
    })
  );

  router.post(
    "/tasks/:id/workflow-step",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const body = req.body as { stepId?: string; action?: WorkflowNodeAction };
      const stepId = body.stepId?.trim();
      const action = body.action;
      if (!stepId || !action || !["approve", "jump", "rollback", "skip"].includes(action)) {
        res.status(400).json({ error: "stepId and action (approve|jump|rollback|skip) are required." });
        return;
      }
      const task = await getTask(options.root, id);
      if (!task?.workflowRun) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      const workflow = await loadWorkflow(options.root, task.workflowRun.workflowId);
      if (!nodeActionAllowed(workflow, task, stepId, action)) {
        res.status(409).json({ error: `Action ${action} is not allowed on step ${stepId}.` });
        return;
      }
      const nextRun = applyWorkflowNodeAction(workflow, task, stepId, action);
      if (!nextRun) {
        res.status(409).json({ error: "Could not apply workflow action." });
        return;
      }
      const updated = await updateTask(options.root, id, (current) => ({
        ...current,
        workflowRun: nextRun,
        updatedAt: new Date().toISOString()
      }));
      res.json(updated);
    })
  );

  router.post(
    "/tasks/:id/revert-step",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const body = req.body as { stepId?: string; message?: string; run?: boolean; attachmentIds?: unknown };
      const stepId = body.stepId?.trim();
      const attachmentIds = asStringArray(body.attachmentIds);
      if (!stepId) {
        res.status(400).json({ error: "stepId is required." });
        return;
      }
      const current = await getTask(options.root, id);
      if (!current?.workflowRun) {
        res.status(404).json({ error: "Task not found." });
        return;
      }
      if (isTaskRunning(current, listInflightTaskIds())) {
        res.status(409).json({ error: "Cannot revert while the task is running. Stop it first." });
        return;
      }

      let task: HarnessTask;
      try {
        task = await revertTaskToWorkflowStep(options.root, id, stepId, {
          ...(body.message !== undefined ? { message: body.message } : {}),
          ...(attachmentIds ? { attachmentIds } : {})
        });
      } catch (error) {
        res.status(409).json({ error: (error as Error).message });
        return;
      }

      let turn: { runId: string; execution: string } | null = null;
      if (body.run !== false) {
        turn = await runTaskTurn(options.root, id, runTurnOptions);
      }
      res.json({ task: (await getTask(options.root, id)) ?? task, turn });
    })
  );

  router.post(
    "/tasks/:id/stage-agents/:stage",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const stage = param(req.params["stage"], "stage");
      const agent = (req.body as { agent?: string }).agent;
      if (!agent || !(await isRegisteredAgent(options.root, agent))) {
        res.status(400).json({ error: unregisteredAgentMessage(agent ?? "") });
        return;
      }
      res.json(
        await setTaskStageAgentOverride(options.root, id, stage, agent as ToolId)
      );
    })
  );

  router.delete(
    "/tasks/:id/stage-agents/:stage",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const stage = param(req.params["stage"], "stage");
      res.json(await clearTaskStageAgentOverride(options.root, id, stage));
    })
  );

  router.post(
    "/tasks/:id/stage-effort/:stage",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const stage = param(req.params["stage"], "stage");
      const effort = (req.body as { effort?: string }).effort;
      if (!isEffortLevel(effort)) {
        res.status(400).json({ error: `Invalid effort level: ${String(effort ?? "")}` });
        return;
      }
      res.json(await setTaskStageEffortOverride(options.root, id, stage, effort));
    })
  );

  router.delete(
    "/tasks/:id/stage-effort/:stage",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const stage = param(req.params["stage"], "stage");
      res.json(await clearTaskStageEffortOverride(options.root, id, stage));
    })
  );

  router.post(
    "/tasks/:id/pm-status",
    asyncRoute(async (req, res) => {
      const body = req.body as { value?: PmStatus };
      const value = body.value;
      if (!value || !["backlog", "in_progress", "in_review", "done"].includes(value)) {
        res.status(400).json({ error: "value must be backlog, in_progress, in_review, or done." });
        return;
      }
      res.json(await setPmStatusOverride(options.root, param(req.params["id"], "id"), value));
    })
  );

  router.delete(
    "/tasks/:id",
    asyncRoute(async (req, res) => {
      res.json(await deleteTask(options.root, param(req.params["id"], "id")));
    })
  );

  router.post(
    "/tasks/:id/messages",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const body = req.body as {
        author?: "operator" | "agent" | "system";
        body?: string;
        stepId?: string;
        noteOnly?: boolean;
        attachmentIds?: unknown;
      };
      const stepId = body.stepId?.trim() || undefined;
      const attachmentIds = asStringArray(body.attachmentIds);
      const message = await addTaskMessage(options.root, id, {
        author: body.author ?? "operator",
        body: body.body ?? "",
        ...(stepId ? { stepId } : {}),
        ...(attachmentIds ? { attachmentIds } : {})
      });

      let turn: { runId: string; execution: string } | null = null;
      const task = await getTask(options.root, id);
      if (task && message.author === "operator" && !body.noteOnly) {
        // If a live turn is active and accepts mid-turn input, route the message
        // into the running process instead of scheduling a new turn. Include
        // attachment references so the agent can read the operator's files.
        const live = deliverOperatorMessageToLiveTurn(
          id,
          withAttachmentReferences(body.body ?? "", options.root, message.attachments)
        );
        if (live.delivered) {
          turn = { runId: live.runId ?? "", execution: "running" };
        } else {
          const prepared = await preparePlanRefinementTurn(options.root, id);
          if (prepared) {
            turn = await runTaskTurn(options.root, id, runTurnOptions);
          } else if (task.workflowRun) {
            const workflow = await loadWorkflow(options.root, task.workflowRun.workflowId);
            if (isAwaitingOperator(task, workflow)) {
              turn = await runTaskTurn(options.root, id, runTurnOptions);
            } else {
              turn = await runOperatorFollowupTurn(options.root, id, runTurnOptions);
            }
          } else {
            turn = await runOperatorFollowupTurn(options.root, id, runTurnOptions);
          }
        }
      }

      res.status(201).json({ message, turn });
    })
  );

  router.post(
    "/tasks/:id/turn",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const result = await runTaskTurn(options.root, id, runTurnOptions);
      if (!result) {
        res.status(409).json({ error: "Task is not in a state where a turn can be run." });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    "/daemon/process-one",
    asyncRoute(async (_req, res) => {
      const result = await processNextApprovedTask(options.root, runTurnOptions);
      if (!result) {
        res.status(204).send();
        return;
      }
      res.json(result);
    })
  );

  return router;
}
