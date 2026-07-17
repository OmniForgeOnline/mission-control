import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionManager,
  type PtyHandle,
  type PtySpawnOptions,
  type SessionManager
} from "../src/terminal/session-manager.ts";
import { createRingBuffer } from "../src/terminal/ring-buffer.ts";

function fakePtyFactory() {
  const handles: Array<{
    opts: PtySpawnOptions;
    handle: PtyHandle;
    emitData: (data: string) => void;
    emitExit: (code: number) => void;
  }> = [];

  const spawn = (opts: PtySpawnOptions): PtyHandle => {
    let dataCb: ((data: string) => void) | null = null;
    let exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
    const written: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    let killed: string | undefined;

    const handle: PtyHandle = {
      pid: 1000 + handles.length,
      cols: opts.cols,
      rows: opts.rows,
      write(data: string) {
        written.push(data);
      },
      resize(cols: number, rows: number) {
        resizes.push({ cols, rows });
        (handle as { cols: number }).cols = cols;
        (handle as { rows: number }).rows = rows;
      },
      kill(signal = "SIGTERM") {
        killed = signal;
      },
      onData(cb) {
        dataCb = cb;
      },
      onExit(cb) {
        exitCb = cb;
      }
    };

    const entry = {
      opts,
      handle,
      emitData: (data: string) => dataCb?.(data),
      emitExit: (code: number) => exitCb?.({ exitCode: code }),
      written,
      resizes,
      get killed() {
        return killed;
      }
    };
    handles.push(entry as (typeof handles)[number] & typeof entry);
    return handle;
  };

  return { spawn, handles: handles as Array<{
    opts: PtySpawnOptions;
    handle: PtyHandle;
    emitData: (data: string) => void;
    emitExit: (code: number) => void;
    written: string[];
    resizes: Array<{ cols: number; rows: number }>;
    killed: string | undefined;
  }> };
}

describe("ring buffer", () => {
  it("retains only the most recent bytes up to capacity", () => {
    const buf = createRingBuffer(8);
    buf.push("abcdefgh");
    buf.push("ij");
    expect(buf.toString()).toBe("cdefghij");
  });

  it("returns empty string when nothing was pushed", () => {
    expect(createRingBuffer(16).toString()).toBe("");
  });
});

describe("terminal session manager", () => {
  let manager: SessionManager;

  afterEach(() => {
    manager?.disposeAll();
  });

  it("creates a session with cwd, env, and command from spawn options", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn });

    const session = manager.create({
      command: "/usr/bin/claude",
      args: [],
      cwd: "/tmp/work",
      env: { PATH: "/bin", HOME: "/Users/me" },
      cols: 100,
      rows: 30,
      taskId: "task-1",
      runId: "run-1"
    });

    expect(session.id).toMatch(/^term_/);
    expect(session.taskId).toBe("task-1");
    expect(session.runId).toBe("run-1");
    expect(session.alive).toBe(true);
    expect(fake.handles).toHaveLength(1);
    expect(fake.handles[0]!.opts.command).toBe("/usr/bin/claude");
    expect(fake.handles[0]!.opts.cwd).toBe("/tmp/work");
    expect(fake.handles[0]!.opts.env["TERM"]).toBe("xterm-256color");
    expect(fake.handles[0]!.opts.env["COLORTERM"]).toBe("truecolor");
    expect(fake.handles[0]!.opts.env["PATH"]).toBe("/bin");
  });

  it("forwards input and resize to the underlying PTY", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn });
    const session = manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24
    });

    manager.write(session.id, "hello");
    manager.resize(session.id, 120, 40);

    expect(fake.handles[0]!.written).toEqual(["hello"]);
    expect(fake.handles[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(manager.get(session.id)?.cols).toBe(120);
    expect(manager.get(session.id)?.rows).toBe(40);
  });

  it("replays ring-buffered output to a newly attached subscriber", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn, scrollbackBytes: 1024 });
    const session = manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24
    });

    fake.handles[0]!.emitData("line one\n");
    fake.handles[0]!.emitData("line two\n");

    const received: string[] = [];
    const unsubscribe = manager.subscribe(session.id, (msg) => {
      if (msg.type === "output") received.push(msg.data);
    });

    expect(received.join("")).toBe("line one\nline two\n");
    unsubscribe();
  });

  it("forwards live output after subscribe and emits exit", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn });
    const session = manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24
    });

    const messages: Array<{ type: string; data?: string; code?: number | null }> = [];
    manager.subscribe(session.id, (msg) => {
      if (msg.type === "output") messages.push({ type: msg.type, data: msg.data });
      if (msg.type === "exit") messages.push({ type: msg.type, code: msg.code });
    });

    fake.handles[0]!.emitData("live");
    fake.handles[0]!.emitExit(0);

    expect(messages).toEqual([
      { type: "output", data: "live" },
      { type: "exit", code: 0 }
    ]);
    expect(manager.get(session.id)?.alive).toBe(false);
  });

  it("kills the PTY on dispose and removes the session", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn });
    const session = manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24
    });

    manager.dispose(session.id);
    expect(fake.handles[0]!.killed).toBe("SIGTERM");
    expect(manager.get(session.id)).toBeUndefined();
  });

  it("finds the active session for a task", () => {
    const fake = fakePtyFactory();
    manager = createSessionManager({ spawn: fake.spawn });
    manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24,
      taskId: "t-a"
    });
    const b = manager.create({
      command: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24,
      taskId: "t-b"
    });

    expect(manager.findByTaskId("t-b")?.id).toBe(b.id);
    expect(manager.findByTaskId("missing")).toBeUndefined();
  });

  it("throws when writing to an unknown session", () => {
    manager = createSessionManager({ spawn: () => {
      throw new Error("should not spawn");
    } });
    expect(() => manager.write("nope", "x")).toThrow(/unknown session/i);
  });
});
