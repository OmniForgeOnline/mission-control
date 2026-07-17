import { Router } from "express";
import path from "node:path";

import { loadAgentConfig } from "../../core/agents/config/store.ts";
import { getTask } from "../../core/tasks/tasks.ts";
import { buildInteractiveLaunch, buildShellLaunch } from "../../terminal/interactive-launch.ts";
import { buildPtyEnvironment } from "../../terminal/env.ts";
import { getTerminalSessionManager } from "../../terminal/manager.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

interface CreateBody {
  kind?: "shell" | "agent";
  toolId?: string;
  modelPoolId?: string;
  taskId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  label?: string;
}

export function createTerminalRouter(options: ServerOptions): Router {
  const router = Router();

  router.get(
    "/terminal/sessions",
    asyncRoute(async (_req, res) => {
      res.json({ sessions: getTerminalSessionManager().list() });
    })
  );

  router.get(
    "/terminal/sessions/:id",
    asyncRoute(async (req, res) => {
      const session = getTerminalSessionManager().get(param(req.params["id"], "id"));
      if (!session) {
        res.status(404).json({ error: "Terminal session not found." });
        return;
      }
      res.json(session);
    })
  );

  router.post(
    "/terminal/sessions",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as CreateBody;
      const kind = body.kind === "agent" ? "agent" : "shell";
      const cols = typeof body.cols === "number" ? body.cols : undefined;
      const rows = typeof body.rows === "number" ? body.rows : undefined;

      let cwd = typeof body.cwd === "string" && body.cwd.trim() ? path.resolve(body.cwd) : process.cwd();
      let taskId: string | undefined;
      let runId: string | undefined;

      if (typeof body.taskId === "string" && body.taskId) {
        const task = await getTask(options.root, body.taskId);
        if (!task) {
          res.status(404).json({ error: `Task not found: ${body.taskId}` });
          return;
        }
        taskId = task.id;
        runId = task.runId;
        if (task.workspacePath) {
          cwd = task.workspacePath;
        } else if (task.targets[0]) {
          const t = task.targets[0];
          cwd = t.kind === "directory" ? t.path : path.dirname(t.path);
        }
      }

      const manager = getTerminalSessionManager();

      // Never spawn a second agent/shell for a task that already has a live PTY
      // (including the daemon interactive turn). Attach to that session instead.
      if (taskId) {
        const existing = manager.findByTaskId(taskId);
        if (existing?.alive) {
          res.status(200).json(existing);
          return;
        }
      }

      let command: string;
      let args: string[];
      let env: Record<string, string>;
      let label = body.label;

      if (kind === "shell") {
        const launch = buildShellLaunch(cwd);
        command = launch.command;
        args = launch.args;
        env = buildPtyEnvironment(launch.env);
        label = label ?? "shell";
      } else {
        const toolId = typeof body.toolId === "string" ? body.toolId : "";
        if (!toolId) {
          res.status(400).json({ error: "toolId is required for kind=agent." });
          return;
        }
        const config = await loadAgentConfig(options.root);
        const tool = config.tools.find((t) => t.id === toolId && t.enabled);
        if (!tool) {
          res.status(404).json({ error: `Unknown or disabled tool: ${toolId}` });
          return;
        }
        const pool =
          (body.modelPoolId
            ? config.pools.find((p) => p.id === body.modelPoolId)
            : config.pools.find((p) => p.toolId === tool.id && p.enabled)) ?? null;
        const launch = buildInteractiveLaunch(tool, pool, cwd);
        if (!launch) {
          res.status(400).json({
            error: `Tool "${toolId}" has no interactive TUI mode (adapter: ${tool.adapter}).`
          });
          return;
        }
        command = launch.command;
        args = launch.args;
        env = buildPtyEnvironment(launch.env);
        label = label ?? toolId;
      }

      try {
        const session = manager.create({
          command,
          args,
          cwd,
          env,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
          ...(runId !== undefined ? { runId } : {}),
          ...(label !== undefined ? { label } : {})
        });
        res.status(201).json(session);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })
  );

  router.delete(
    "/terminal/sessions/:id",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const manager = getTerminalSessionManager();
      if (!manager.get(id)) {
        res.status(404).json({ error: "Terminal session not found." });
        return;
      }
      manager.dispose(id);
      res.status(204).end();
    })
  );

  return router;
}
