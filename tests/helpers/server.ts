import type http from "node:http";

import { createServer as createHarnessServer, type ServerOptions } from "../../src/server/app.ts";

/**
 * supertest binds a fresh ephemeral server for every request when it is handed a
 * bare app function, then closes that server once the response is read. Under
 * load that listen/close churn can recycle an ephemeral port while a prior
 * connection is still tearing down, desyncing the HTTP stream. That surfaces as
 * "Parse Error: Expected HTTP/, RTSP/ or ICE/" or as a request reading another
 * request's response (wrong status code).
 *
 * Listening once and reusing the same server for every request in the test
 * removes the churn entirely: supertest skips its own listen/close dance when
 * the server it is given is already listening.
 */
export async function startServer(options: ServerOptions): Promise<http.Server> {
  const server = createHarnessServer(options).listen(0);
  await waitForListening(server);
  return server;
}

export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function waitForListening(server: http.Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.once("listening", resolve);
  });
}
