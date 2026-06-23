import { Router } from "express";

import { isProposalTicket } from "../../core/proposals/ticket.ts";
import { proposalTaskToRecord } from "../../core/proposals/proposals.ts";
import { approveTask, cancelTask, getTask } from "../../core/tasks/tasks.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

export function createProposalsRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/proposals/:id/approve",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const task = await getTask(options.root, id);
      if (!task || !isProposalTicket(task)) {
        res.status(404).json({ error: `Proposal not found: ${id}` });
        return;
      }
      if (task.resolution === "completed" || task.resolution === "cancelled") {
        res.json(proposalTaskToRecord(task));
        return;
      }
      res.json(proposalTaskToRecord(await approveTask(options.root, id)));
    })
  );

  router.post(
    "/proposals/:id/reject",
    asyncRoute(async (req, res) => {
      const id = param(req.params["id"], "id");
      const task = await getTask(options.root, id);
      if (!task || !isProposalTicket(task)) {
        res.status(404).json({ error: `Proposal not found: ${id}` });
        return;
      }
      res.json(proposalTaskToRecord(await cancelTask(options.root, id)));
    })
  );

  return router;
}