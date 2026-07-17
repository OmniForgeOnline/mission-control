import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { parseClientMessage, type TerminalServerMessage } from "./protocol.ts";
import type { SessionManager } from "./session-manager.ts";

const WS_PATH = "/api/terminal/ws";

export interface AttachTerminalOptions {
  manager: SessionManager;
  /**
   * When the server is bound beyond loopback, require this token via
   * `?token=` or `Sec-WebSocket-Protocol` for upgrades.
   */
  authToken?: string;
  /** Host the HTTP server listens on (for loopback-only auth skip). */
  listenHost?: string;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function sessionIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname !== WS_PATH) return null;
    const id = parsed.searchParams.get("sessionId");
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function tokenFromRequest(req: IncomingMessage, url: string | undefined): string | null {
  if (url) {
    try {
      const parsed = new URL(url, "http://localhost");
      const q = parsed.searchParams.get("token");
      if (q) return q;
    } catch {
      /* ignore */
    }
  }
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string" && proto.length > 0) {
    return proto.split(",")[0]?.trim() ?? null;
  }
  return null;
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

/**
 * Attach a terminal WebSocket server to the existing HTTP server.
 * Path: `/api/terminal/ws?sessionId=<id>`
 */
export function attachTerminalWebSocketServer(
  server: HttpServer,
  options: AttachTerminalOptions
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith(WS_PATH)) return;

    const sessionId = sessionIdFromUrl(url);
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isLoopbackHost(options.listenHost)) {
      const token = tokenFromRequest(req, url);
      if (!options.authToken || token !== options.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const session = options.manager.get(sessionId);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sessionId);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, sessionId: string) => {
    const info = options.manager.get(sessionId);
    if (!info) {
      send(ws, { type: "error", message: "Session not found" });
      ws.close();
      return;
    }

    send(ws, {
      type: "ready",
      cols: info.cols,
      rows: info.rows,
      sessionId: info.id
    });

    const unsubscribe = options.manager.subscribe(sessionId, (msg) => {
      send(ws, msg);
    });

    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const msg = parseClientMessage(text);
      if (!msg) return;
      try {
        if (msg.type === "input") {
          options.manager.write(sessionId, msg.data);
        } else if (msg.type === "resize") {
          options.manager.resize(sessionId, msg.cols, msg.rows);
        } else if (msg.type === "ping") {
          send(ws, { type: "pong" });
        }
      } catch (err) {
        send(ws, {
          type: "error",
          message: err instanceof Error ? err.message : String(err)
        });
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });
  });

  return wss;
}
