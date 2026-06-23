import type { Response } from "express";

import type { StateScope } from "../core/infra/state-bus.ts";
import { onStateChange } from "../core/infra/state-bus.ts";

interface Client {
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

const clients = new Set<Client>();

let wired = false;

function wireBus(): void {
  if (wired) return;
  wired = true;
  onStateChange((scopes) => notifyStateChange(scopes));
}

export function subscribeStateEvents(res: Response): void {
  wireBus();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30_000);
  heartbeat.unref?.();

  const client: Client = { res, heartbeat };
  clients.add(client);

  res.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

function notifyStateChange(scopes: StateScope[]): void {
  if (!scopes.length) return;
  const payload = JSON.stringify({ scopes });
  for (const client of clients) {
    client.res.write(`event: state-changed\ndata: ${payload}\n\n`);
  }
}