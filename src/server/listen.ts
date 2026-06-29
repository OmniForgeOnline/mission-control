import type { Server } from "node:http";

import type express from "express";

/**
 * Bind an Express app and resolve only once the socket is actually listening.
 *
 * Rejects on the server `error` event (e.g. `EADDRINUSE` when the port is
 * already owned). A second startup against a live server therefore fails the
 * bind *before* the caller records its identity in `server.json`, so it can
 * never overwrite the running server's pid/token and strand it beyond
 * `mission-control stop`.
 */
export function startListening(
  app: express.Express,
  port: number,
  host: string
): Promise<Server> {
  const server = app.listen(port, host);
  return new Promise<Server>((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    // Some transports report `listening` synchronously; if the bind is already
    // settled, resolve now instead of leaving the listeners dangling.
    if (server.listening) {
      server.off("listening", onListening);
      server.off("error", onError);
      resolve(server);
    }
  });
}
