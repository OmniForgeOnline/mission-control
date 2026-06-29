import type { ChildProcessWithoutNullStreams } from "node:child_process";

type Json = Record<string, unknown>;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class AcpResponseError extends Error {
  readonly data?: unknown;
  readonly code?: number;

  constructor(message: string, options?: { code?: number; data?: unknown }) {
    super(message);
    this.name = "AcpResponseError";
    if (options?.code !== undefined) this.code = options.code;
    if (options?.data !== undefined) this.data = options.data;
  }
}

/** Handles a client-bound request from the agent; returns the JSON-RPC result. */
export type RequestHandler = (params: Json) => Promise<unknown> | unknown;

/**
 * Minimal newline-delimited JSON-RPC 2.0 client for ACP over a child process's
 * stdio. Correlates responses by id, dispatches agent-initiated requests to
 * registered handlers, and forwards notifications.
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: ((method: string, params: Json) => void) | undefined;
  private buffer = "";
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("close", () => this.onClose());
  }

  onNotification(handler: (method: string, params: Json) => void): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params: Json): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`ACP connection closed (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
  }

  private write(message: Json): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* ignore: close handler rejects pending requests */
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return; // ignore non-JSON noise
    }

    const id = message["id"];
    const method = message["method"];

    if (typeof method === "string" && id !== undefined) {
      void this.handleRequest(method, (message["params"] as Json) ?? {}, id as number | string);
      return;
    }
    if (typeof method === "string") {
      this.notificationHandler?.(method, (message["params"] as Json) ?? {});
      return;
    }
    if (id !== undefined) {
      this.resolveResponse(id as number, message);
    }
  }

  private async handleRequest(method: string, params: Json, id: number | string): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: messageText } });
    }
  }

  private resolveResponse(id: number, message: Json): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message["error"]) {
      const error = message["error"] as { code?: number; message?: string; data?: unknown };
      pending.reject(new AcpResponseError(error.message ?? "ACP request failed", {
        ...(typeof error.code === "number" ? { code: error.code } : {}),
        ...(error.data !== undefined ? { data: error.data } : {})
      }));
    } else {
      pending.resolve(message["result"]);
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("ACP connection closed before response"));
    }
    this.pending.clear();
  }
}
