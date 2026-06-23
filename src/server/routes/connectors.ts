import { Router } from "express";

import {
  connectWithGhCli,
  connectWithToken,
  disconnectConnector,
  importConnectorTasks,
  listConnectorResources,
  patchConnectorConfig
} from "../../connectors/connections.ts";
import { createTask } from "../../core/tasks/tasks.ts";
import { asConnectorProviderId, asyncRoute, connectorVaultOptions, param, type ServerOptions } from "./helpers.ts";

export function createConnectorsRouter(options: ServerOptions): Router {
  const router = Router();

  router.post(
    "/connectors/:providerId/connect",
    asyncRoute(async (req, res) => {
      const providerId = asConnectorProviderId(param(req.params["providerId"], "providerId"));
      const method = typeof req.body?.method === "string" ? req.body.method : "token";

      if (method === "gh") {
        if (providerId !== "github") {
          res.status(400).json({ error: "GitHub CLI auth is only available for GitHub." });
          return;
        }
        res.json(await connectWithGhCli(options.root, connectorVaultOptions(options)));
        return;
      }

      const token = typeof req.body?.token === "string" ? req.body.token : "";
      res.json(await connectWithToken(options.root, providerId, token, connectorVaultOptions(options)));
    })
  );

  router.delete(
    "/connectors/:connectionId",
    asyncRoute(async (req, res) => {
      const removed = await disconnectConnector(
        options.root,
        param(req.params["connectionId"], "connectionId"),
        connectorVaultOptions(options)
      );
      if (!removed) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      res.status(204).end();
    })
  );

  router.patch(
    "/connectors/:connectionId",
    asyncRoute(async (req, res) => {
      const connection = await patchConnectorConfig(
        options.root,
        param(req.params["connectionId"], "connectionId"),
        req.body?.config ?? req.body ?? {}
      );
      res.json(connection);
    })
  );

  router.get(
    "/connectors/:connectionId/resources",
    asyncRoute(async (req, res) => {
      const resources = await listConnectorResources(
        options.root,
        param(req.params["connectionId"], "connectionId"),
        {
          ...connectorVaultOptions(options),
          refresh: req.query["refresh"] === "1" || req.query["refresh"] === "true"
        }
      );
      res.json(resources);
    })
  );

  router.post(
    "/connectors/:connectionId/import",
    asyncRoute(async (req, res) => {
      const imported = await importConnectorTasks(
        options.root,
        param(req.params["connectionId"], "connectionId"),
        connectorVaultOptions(options)
      );
      const tasks = [];
      for (const input of imported) {
        tasks.push(await createTask(options.root, input));
      }
      res.status(201).json(tasks);
    })
  );

  return router;
}
