import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/server/app.ts";
import type { DaemonHandle } from "../src/daemon/loop.ts";
import {
  type ShutdownTarget,
  gracefulShutdown,
  isShuttingDown,
  resetShutdownState,
  setShutdownTarget
} from "../src/server/lifecycle.ts";
import {
  isPidAlive,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  stopRunningServer,
  writeServerInfo
} from "../src/server/control.ts";
import {
  abortAllInflightTurns,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import type { AgentRunner } from "../src/runners/types.ts";

class MockRunner implements AgentRunner {
  agent = "codex" as const;
  aborted = false;

  abort(): void {
    this.aborted = true;
  }

  runTurn(): Promise<never> {
    return new Promise(() => {});
  }
}

/** Minimal shutdown target pieces with spied methods and a no-op exit. */
function fakeTarget(): ShutdownTarget {
  return {
    exit: vi.fn(),
    server: { close: vi.fn() } as unknown as Server,
    daemon: { stop: vi.fn().mockResolvedValue(undefined) } as unknown as DaemonHandle,
    onShutdown: vi.fn().mockResolvedValue(undefined)
  };
}

describe("graceful shutdown orchestration", () => {
  beforeEach(() => {
    resetShutdownState();
    abortAllInflightTurns();
  });

  afterEach(() => {
    resetShutdownState();
    abortAllInflightTurns();
  });

  it("terminates every running agent process, stops the daemon, and closes the server", async () => {
    const t = fakeTarget();
    const a = new MockRunner();
    const b = new MockRunner();
    registerInflightTurn("task-a", a);
    registerInflightTurn("task-b", b);
    setShutdownTarget(t);

    const result = await gracefulShutdown("test");

    expect(result.terminated).toBe(2);
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    expect(listInflightTaskIds()).toEqual([]);
    expect(t.daemon?.stop).toHaveBeenCalled();
    expect(t.server?.close).toHaveBeenCalled();
    expect(t.onShutdown).toHaveBeenCalled();
    expect(isShuttingDown()).toBe(true);
  });

  it("still closes the server and runs cleanup when nothing is running", async () => {
    const t = fakeTarget();
    setShutdownTarget(t);

    const result = await gracefulShutdown("idle");

    expect(result.terminated).toBe(0);
    expect(t.server?.close).toHaveBeenCalled();
    expect(t.onShutdown).toHaveBeenCalled();
  });

  it("force-exits immediately on a second shutdown request", async () => {
    const t = fakeTarget();
    setShutdownTarget(t);

    await gracefulShutdown("first");
    expect(t.exit).not.toHaveBeenCalled();

    await gracefulShutdown("second");
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it("schedules a bounded force-exit after the grace window", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget();
      setShutdownTarget(t);

      await gracefulShutdown("timed");
      // Not yet: the grace window has not elapsed.
      expect(t.exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3_000);
      expect(t.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/api/shutdown route", () => {
  // A fixed per-server token so the auth contract is asserted deterministically.
  const SHUTDOWN_TOKEN = "test-shutdown-secret";

  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-shutdown-route-"));
    await ensureHarnessRepository(root);
    resetShutdownState();
    abortAllInflightTurns();
  });

  afterEach(() => {
    resetShutdownState();
    abortAllInflightTurns();
    void rm(root, { recursive: true, force: true });
  });

  it("acknowledges and drives the shared graceful path (terminates runners)", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });
    const t = fakeTarget();
    const runner = new MockRunner();
    registerInflightTurn("task-live", runner);
    setShutdownTarget(t);

    const res = await request(app)
      .post("/api/shutdown")
      .set("x-shutdown-token", SHUTDOWN_TOKEN)
      .expect(200);
    expect(res.body.shutting_down).toBe(true);
    expect(res.body.already).toBe(false);

    // The route defers shutdown via setImmediate so the response flushes first;
    // poll for the deferred effect rather than assume timer ordering.
    const deadline = Date.now() + 500;
    while (!runner.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(runner.aborted).toBe(true);
    expect(t.server?.close).toHaveBeenCalled();
    expect(isShuttingDown()).toBe(true);
  });

  it("reports already:true on a repeat request without re-entering shutdown", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });
    const t = fakeTarget();
    setShutdownTarget(t);
    const closeSpy = t.server?.close as unknown as ReturnType<typeof vi.fn>;

    await request(app)
      .post("/api/shutdown")
      .set("x-shutdown-token", SHUTDOWN_TOKEN)
      .expect(200);
    // The route claims synchronously, so isShuttingDown() is already true here;
    // poll for the deferred teardown (server.close) rather than the claim flag.
    const deadline = Date.now() + 500;
    while (closeSpy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const res = await request(app)
      .post("/api/shutdown")
      .set("x-shutdown-token", SHUTDOWN_TOKEN)
      .expect(200);
    expect(res.body.already).toBe(true);
    // No second teardown, and a duplicate API request never force-exits.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("collapses concurrent shutdown requests into one teardown (no force-exit)", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });
    const t = fakeTarget();
    setShutdownTarget(t);
    const closeSpy = t.server?.close as unknown as ReturnType<typeof vi.fn>;

    // Two requests back-to-back. Before the claim was made synchronous, the
    // second could land before the first setImmediate fired, so both scheduled
    // teardown and the second hit gracefulShutdown's force-exit branch.
    const [a, b] = await Promise.all([
      request(app).post("/api/shutdown").set("x-shutdown-token", SHUTDOWN_TOKEN),
      request(app).post("/api/shutdown").set("x-shutdown-token", SHUTDOWN_TOKEN)
    ]);

    // Exactly one request initiated shutdown; the other was told it's in progress.
    expect([a.body.already, b.body.already].filter(Boolean)).toHaveLength(1);
    // A duplicate API request must never take the escalating force-exit path.
    expect(t.exit).not.toHaveBeenCalled();

    // Exactly one teardown runs.
    const deadline = Date.now() + 500;
    while (closeSpy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("rejects a request without the shutdown token with 401 and never begins teardown", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });
    const t = fakeTarget();
    const runner = new MockRunner();
    registerInflightTurn("task-live", runner);
    setShutdownTarget(t);

    const res = await request(app).post("/api/shutdown").expect(401);
    expect(res.body.error).toBeTruthy();

    // An unauthenticated request must not claim shutdown or touch anything: no
    // CSRF-style cross-site POST (which cannot set a custom header) can shut us.
    expect(isShuttingDown()).toBe(false);
    expect(runner.aborted).toBe(false);
    expect(t.server?.close).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong shutdown token with 401", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });
    const t = fakeTarget();
    setShutdownTarget(t);

    await request(app)
      .post("/api/shutdown")
      .set("x-shutdown-token", "not-the-secret")
      .expect(401);

    expect(isShuttingDown()).toBe(false);
    expect(t.server?.close).not.toHaveBeenCalled();
  });

  it("exposes the per-server shutdown token via /api/state boot state", async () => {
    const app = createServer({ root, testMode: true, shutdownToken: SHUTDOWN_TOKEN });

    const res = await request(app).get("/api/state").expect(200);
    // The same-origin UI reads this on boot and echoes it in the shutdown header.
    expect(res.body.shutdownToken).toBe(SHUTDOWN_TOKEN);
  });

  it("auto-generates an unguessable token when none is provided and still enforces it", async () => {
    const app = createServer({ root, testMode: true });

    const state = await request(app).get("/api/state").expect(200);
    const token: string = state.body.shutdownToken;
    expect(typeof token).toBe("string");
    // High-entropy hex: 256 bits of randomness so it cannot be guessed remotely.
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[0-9a-f]+$/);

    // Missing token is rejected; the generated token is accepted.
    await request(app).post("/api/shutdown").expect(401);
    await request(app).post("/api/shutdown").set("x-shutdown-token", token).expect(200);
  });
});

describe("mission-control stop (runtime info + CLI client)", () => {
  // The token the running server would have written into server.json at boot.
  const CLI_TOKEN = "cli-shutdown-secret";

  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-shutdown-cli-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes and reads back the server info file under the harness root", async () => {
    await writeServerInfo(root, { pid: 12345, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z", shutdownToken: CLI_TOKEN });
    const info = await readServerInfo(root);
    expect(info).toEqual({ pid: 12345, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z", shutdownToken: CLI_TOKEN });
    expect(serverInfoPath(root).endsWith(path.join("data", "state", "server.json"))).toBe(true);
  });

  it("reports not running when no server info exists", async () => {
    const outcome = await stopRunningServer(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not running");
  });

  it("cleans up a stale info file whose pid is dead and reports not running", async () => {
    // pid 1 is always alive on Linux but init is not us; use a pid certain to be
    // unused on macOS/Linux test runners (a very large, recycled value).
    const deadPid = 4_000_000;
    expect(isPidAlive(deadPid)).toBe(false);
    await writeServerInfo(root, { pid: deadPid, port: 4827, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z", shutdownToken: CLI_TOKEN });

    const outcome = await stopRunningServer(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not running");
    // Stale state was removed so a subsequent call is a clean "not running".
    expect(await readServerInfo(root)).toBeNull();
  });

  it("fails clearly when the recorded server is unreachable", async () => {
    // This process is alive, but nothing listens on an unlikely high port.
    await writeServerInfo(root, { pid: process.pid, port: 1, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z", shutdownToken: CLI_TOKEN });

    const outcome = await stopRunningServer(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.message.toLowerCase()).toContain("could not reach");
  });

  it("asks a live server to shut down over /api/shutdown and reports success", async () => {
    let receivedShutdown = false;
    let receivedToken: string | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/shutdown") {
        // Mirror the real server's auth gate so the CLI's header is exercised:
        // a missing or wrong token is rejected before shutdown begins.
        const token = req.headers["x-shutdown-token"];
        if (token !== CLI_TOKEN) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Shutdown not authorized." }));
          return;
        }
        receivedToken = Array.isArray(token) ? token[0] : token;
        receivedShutdown = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ shutting_down: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await writeServerInfo(root, { pid: process.pid, port, host: "127.0.0.1", startedAt: "2026-06-29T00:00:00.000Z", shutdownToken: CLI_TOKEN });
      const outcome = await stopRunningServer(root);
      expect(outcome.ok).toBe(true);
      expect(receivedShutdown).toBe(true);
      // The CLI authenticated with the token it read from server.json.
      expect(receivedToken).toBe(CLI_TOKEN);
      expect(outcome.message).toContain("shutting down");
      expect(outcome.message).toContain("unavailable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("removeServerInfo is idempotent when no file exists", async () => {
    await expect(removeServerInfo(root)).resolves.toBeUndefined();
  });
});
