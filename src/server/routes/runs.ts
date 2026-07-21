import path from "node:path";
import { Router } from "express";

import { cleanRuns, listAllRuns } from "../../core/tasks/runs.ts";
import { readRunEvents, subscribeRunEvents } from "../../core/runs/events.ts";
import { inspectRunRoutingDecision } from "../../core/runs/routing-inspect.ts";
import { deliverOperatorMessageToLiveTurn } from "../../runtime/sessions.ts";
import { asyncRoute, param, type ServerOptions } from "./helpers.ts";
import { stopRun } from "./run-control.ts";

export function createRunsRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/runs/:runId/kill",
    asyncRoute(async (req, res) => {
      res.json(await stopRun(options.root, param(req.params["runId"], "runId")));
    })
  );

  router.post(
    "/runs/:runId/input",
    asyncRoute(async (req, res) => {
      const runId = param(req.params["runId"], "runId");
      const text = ((req.body as { text?: string }).text ?? "").trim();
      if (!text) {
        res.status(400).json({ error: "text is required." });
        return;
      }
      const run = (await listAllRuns(options.root)).find((candidate) => candidate.id === runId);
      if (!run) {
        res.status(404).json({ error: "Run not found." });
        return;
      }
      const result = deliverOperatorMessageToLiveTurn(run.taskId, text);
      if (!result.delivered) {
        res.status(409).json({ delivered: false, error: "Run is not accepting mid-turn input." });
        return;
      }
      res.json({ delivered: true });
    })
  );

  router.post(
    "/runs/:runId/cancel",
    asyncRoute(async (req, res) => {
      res.json(await stopRun(options.root, param(req.params["runId"], "runId")));
    })
  );

  router.post(
    "/runs/clean",
    asyncRoute(async (req, res) => {
      const projectId = (req.query["projectId"] as string | undefined)?.trim() || undefined;
      res.json(await cleanRuns(options.root, projectId));
    })
  );

  router.get(
    "/runs/:runId/events",
    asyncRoute(async (req, res) => {
      const runId = param(req.params["runId"], "runId");
      const since = Math.max(0, Number((req.query["since"] as string) ?? 0) || 0);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write(": connected\n\n");

      const writeEvent = (event: unknown): void => {
        res.write(`event: run-event\ndata: ${JSON.stringify(event)}\n\n`);
      };

      // Replay everything past the client's offset, then stream live.
      for (const event of await readRunEvents(options.root, runId, since)) {
        writeEvent(event);
      }
      const unsubscribe = subscribeRunEvents(runId, writeEvent);

      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 30_000);
      heartbeat.unref?.();

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    })
  );

  router.get(
    "/runs/:runId/tail",
    asyncRoute(async (req, res) => {
      const runId = param(req.params["runId"], "runId");
      const since = Math.max(0, Number((req.query["since"] as string) ?? 0) || 0);
      const logFile = path.join(options.root, "data", "runs", runId, "log.txt");
      try {
        const { open, stat } = await import("node:fs/promises");
        const info = await stat(logFile);
        if (since >= info.size) {
          res.json({ size: info.size, chunk: "", endOfFile: false });
          return;
        }
        const handle = await open(logFile, "r");
        try {
          const length = info.size - since;
          const buf = Buffer.allocUnsafe(length);
          await handle.read(buf, 0, length, since);
          res.json({ size: info.size, chunk: buf.toString("utf8"), endOfFile: false });
        } finally {
          await handle.close();
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ENOENT") {
          res.json({ size: 0, chunk: "", endOfFile: false });
          return;
        }
        res.status(404).json({ error: error.message ?? "log not found" });
      }
    })
  );

  router.get(
    "/runs/:runId/routing",
    asyncRoute(async (req, res) => {
      const view = await inspectRunRoutingDecision(options.root, param(req.params["runId"], "runId"));
      if (!view) {
        res.status(404).json({ error: "Run routing not found." });
        return;
      }
      res.json(view);
    })
  );

  router.get(
    "/runs/:runId/artifacts/:fileName",
    asyncRoute(async (req, res) => {
      res.sendFile(
        path.join(
          options.root,
          "data",
          "runs",
          param(req.params["runId"], "runId"),
          param(req.params["fileName"], "fileName")
        )
      );
    })
  );

  return router;
}
