import { Router } from "express";

import {
  confirmIntakeDraft,
  dismissIntakeDraft,
  getIntakeSession,
  resetIntakeSession
} from "../../core/intake/intake.ts";
import { asyncRoute, type ServerOptions } from "./helpers.ts";

export function createIntakeRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/intake/reset",
    asyncRoute(async (_req, res) => {
      res.json(await resetIntakeSession(options.root));
    })
  );

  router.post(
    "/intake/confirm",
    asyncRoute(async (_req, res) => {
      const turn = await confirmIntakeDraft(options.root);
      res.status(201).json({ turn });
    })
  );

  router.post(
    "/intake/draft/dismiss",
    asyncRoute(async (_req, res) => {
      res.json(await dismissIntakeDraft(options.root));
    })
  );

  router.post(
    "/intake/messages",
    asyncRoute(async (_req, res) => {
      res.status(409).json({
        error: "Ticket intake requires a project. Open a project and create the ticket there."
      });
    })
  );

  router.get(
    "/intake/session",
    asyncRoute(async (_req, res) => {
      res.json(await getIntakeSession(options.root));
    })
  );

  return router;
}
