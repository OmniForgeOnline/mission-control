import { Router } from "express";

import { runAutonomyJob, setAutonomyJobRunMode, setAutonomyJobStatus } from "../../autonomy/jobs.ts";
import type { AutonomyJobStatus, AutonomyRunMode } from "../../autonomy/jobs.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";

export function createAutonomyRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/autonomy/jobs/:id/run",
    asyncRoute(async (req, res) => {
      res.json(await runAutonomyJob(options.root, param(req.params["id"], "id")));
    })
  );

  router.post(
    "/autonomy/jobs/:id/run-mode",
    asyncRoute(async (req, res) => {
      const body = req.body as { runMode?: AutonomyRunMode };
      res.json(
        await setAutonomyJobRunMode(options.root, param(req.params["id"], "id"), body.runMode ?? "manual")
      );
    })
  );

  router.post(
    "/autonomy/jobs/:id/status",
    asyncRoute(async (req, res) => {
      const body = req.body as { status?: AutonomyJobStatus };
      res.json(
        await setAutonomyJobStatus(options.root, param(req.params["id"], "id"), body.status ?? "paused")
      );
    })
  );

  return router;
}