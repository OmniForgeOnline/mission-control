import { randomBytes } from "node:crypto";

import { createRingBuffer, type RingBuffer } from "./ring-buffer.ts";
import type { TerminalServerMessage } from "./protocol.ts";

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Minimal PTY handle used by the session manager (real node-pty or fakes). */
export interface PtyHandle {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void;
}

export type PtySpawner = (opts: PtySpawnOptions) => PtyHandle;

export interface CreateSessionRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  taskId?: string;
  runId?: string;
  label?: string;
}

export interface TerminalSessionInfo {
  id: string;
  taskId?: string;
  runId?: string;
  label?: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  createdAt: string;
  exitCode: number | null;
}

type Subscriber = (msg: TerminalServerMessage) => void;

interface InternalSession {
  info: TerminalSessionInfo;
  pty: PtyHandle;
  scrollback: RingBuffer;
  subscribers: Set<Subscriber>;
}

export interface SessionManagerOptions {
  spawn: PtySpawner;
  /** Max bytes retained for reconnect replay. Default 256 KiB. */
  scrollbackBytes?: number;
  idFactory?: () => string;
}

export interface SessionManager {
  create(req: CreateSessionRequest): TerminalSessionInfo;
  get(id: string): TerminalSessionInfo | undefined;
  findByTaskId(taskId: string): TerminalSessionInfo | undefined;
  list(): TerminalSessionInfo[];
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  subscribe(id: string, cb: Subscriber): () => void;
  dispose(id: string): void;
  disposeAll(): void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 256 * 1024;

function defaultId(): string {
  return `term_${randomBytes(8).toString("hex")}`;
}

function requireSession(sessions: Map<string, InternalSession>, id: string): InternalSession {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown session: ${id}`);
  return session;
}

/**
 * Owns long-lived PTY sessions that outlive individual WebSocket connections.
 * Browser clients attach via subscribe(); refresh reattaches and replays scrollback.
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const sessions = new Map<string, InternalSession>();
  const scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK;
  const idFactory = options.idFactory ?? defaultId;

  function broadcast(session: InternalSession, msg: TerminalServerMessage): void {
    for (const sub of session.subscribers) {
      try {
        sub(msg);
      } catch {
        /* subscriber errors must not kill the PTY fan-out */
      }
    }
  }

  function create(req: CreateSessionRequest): TerminalSessionInfo {
    const cols = req.cols && req.cols > 0 ? Math.floor(req.cols) : DEFAULT_COLS;
    const rows = req.rows && req.rows > 0 ? Math.floor(req.rows) : DEFAULT_ROWS;
    const env: Record<string, string> = {
      ...req.env,
      TERM: req.env["TERM"] ?? "xterm-256color",
      COLORTERM: req.env["COLORTERM"] ?? "truecolor"
    };

    const pty = options.spawn({
      command: req.command,
      args: req.args,
      cwd: req.cwd,
      env,
      cols,
      rows
    });

    const info: TerminalSessionInfo = {
      id: idFactory(),
      ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
      ...(req.runId !== undefined ? { runId: req.runId } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      command: req.command,
      cwd: req.cwd,
      cols,
      rows,
      alive: true,
      createdAt: new Date().toISOString(),
      exitCode: null
    };

    const internal: InternalSession = {
      info,
      pty,
      scrollback: createRingBuffer(scrollbackBytes),
      subscribers: new Set()
    };

    pty.onData((data) => {
      internal.scrollback.push(data);
      broadcast(internal, { type: "output", data });
    });

    pty.onExit(({ exitCode }) => {
      internal.info.alive = false;
      internal.info.exitCode = exitCode;
      broadcast(internal, { type: "exit", code: exitCode });
    });

    sessions.set(info.id, internal);
    return { ...info };
  }

  return {
    create,
    get(id) {
      const session = sessions.get(id);
      return session ? { ...session.info } : undefined;
    },
    findByTaskId(taskId) {
      for (const session of sessions.values()) {
        if (session.info.taskId === taskId && session.info.alive) {
          return { ...session.info };
        }
      }
      // Prefer the most recently created dead session for the task if none alive.
      let latest: InternalSession | undefined;
      for (const session of sessions.values()) {
        if (session.info.taskId !== taskId) continue;
        if (!latest || session.info.createdAt > latest.info.createdAt) latest = session;
      }
      return latest ? { ...latest.info } : undefined;
    },
    list() {
      return [...sessions.values()].map((s) => ({ ...s.info }));
    },
    write(id, data) {
      const session = requireSession(sessions, id);
      if (!session.info.alive) return;
      session.pty.write(data);
    },
    resize(id, cols, rows) {
      const session = requireSession(sessions, id);
      if (cols < 1 || rows < 1) return;
      session.pty.resize(cols, rows);
      session.info.cols = cols;
      session.info.rows = rows;
    },
    subscribe(id, cb) {
      const session = requireSession(sessions, id);
      session.subscribers.add(cb);
      const replay = session.scrollback.toString();
      if (replay) {
        try {
          cb({ type: "output", data: replay });
        } catch {
          /* ignore */
        }
      }
      if (!session.info.alive) {
        try {
          cb({ type: "exit", code: session.info.exitCode });
        } catch {
          /* ignore */
        }
      }
      return () => {
        session.subscribers.delete(cb);
      };
    },
    dispose(id) {
      const session = sessions.get(id);
      if (!session) return;
      try {
        if (session.info.alive) session.pty.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      session.subscribers.clear();
      sessions.delete(id);
    },
    disposeAll() {
      for (const id of [...sessions.keys()]) {
        this.dispose(id);
      }
    }
  };
}
