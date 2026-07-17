/** Client → server terminal WebSocket messages. */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

/** Server → client terminal WebSocket messages. */
export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string }
  | { type: "ready"; cols: number; rows: number; sessionId: string }
  | { type: "pong" };

export function parseClientMessage(raw: string): TerminalClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const msg = parsed as Record<string, unknown>;
  switch (msg["type"]) {
    case "input":
      return typeof msg["data"] === "string" ? { type: "input", data: msg["data"] } : null;
    case "resize": {
      const cols = Number(msg["cols"]);
      const rows = Number(msg["rows"]);
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
      return { type: "resize", cols: Math.floor(cols), rows: Math.floor(rows) };
    }
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}
